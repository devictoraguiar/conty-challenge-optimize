import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.ts";
import { deliveriesSince } from "../src/clock.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { CAMPAIGN_ID, seed } from "../src/seed.ts";

type Match = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

const databases: DatabaseSync[] = [];

function trackedDatabase(): DatabaseSync {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function originalList(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
) {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(input.campaignId) as
    | { niches_json: string }
    | undefined;
  if (!campaign) return null;

  const creators = db.prepare("SELECT * FROM creators").all() as Array<{
    id: string;
    name: string;
    niches_json: string;
  }>;
  const since = deliveriesSince();
  const scored: Match[] = [];

  for (const creator of creators) {
    const campaignNiches = JSON.parse(campaign.niches_json) as string[];
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    const accounts = db.prepare("SELECT * FROM social_accounts WHERE creator_id = ?").all(creator.id) as Array<{
      id: string;
    }>;
    let latestReach = 0;
    for (const account of accounts) {
      const metric = db.prepare(
        "SELECT * FROM metrics WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
      ).get(account.id) as { views: number } | undefined;
      if (metric) latestReach += metric.views;
    }
    const deliveries = db.prepare(
      "SELECT COUNT(*) AS n FROM deliveries WHERE creator_id = ? AND delivered_at >= ?",
    ).get(creator.id, since) as { n: number };

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: latestReach,
      deliveries_90d: Number(deliveries.n),
    });
  }

  scored.sort((left, right) =>
    right.niche_score - left.niche_score ||
    right.latest_reach - left.latest_reach ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: scored.slice(input.offset, input.offset + input.limit),
  };
}

describe("equivalência da listagem em volume alto", () => {
  it("preserva conteúdo, ordenação e limites do algoritmo original acima do seed", async () => {
    const db = trackedDatabase();
    seed(db, { creators: 2000, seed: 7 });
    const app = createApp(db);

    for (const { limit, offset } of [
      { limit: 20, offset: 0 },
      { limit: 50, offset: 10 },
      { limit: 17, offset: 250 },
      { limit: 50, offset: 1980 },
      { limit: 20, offset: 5000 },
    ]) {
      const expected = originalList(db, { campaignId: CAMPAIGN_ID, limit, offset });
      resetQueryCount();
      const response = await app.request(
        `/campaigns/${CAMPAIGN_ID}/creators?limit=${limit}&offset=${offset}`,
      );

      expect(response.status).toBe(200);
      expect(getQueryCount()).toBeLessThanOrEqual(8);
      expect(await response.json()).toEqual(expected);
    }
  });

  it("soma alcances acima do inteiro seguro no JavaScript, conta por conta", async () => {
    const db = trackedDatabase();
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_large', 'Alcance grande', '["beleza"]');
      INSERT INTO creators VALUES ('crt_large', 'Criador grande', '["beleza"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_large_1', 'crt_large', 'instagram'),
        ('acc_large_2', 'crt_large', 'tiktok');
      INSERT INTO metrics VALUES
        ('met_large_1', 'acc_large_1', 9007199254740991, '2026-05-31T00:00:00.000Z', ''),
        ('met_large_2', 'acc_large_2', 9007199254740991, '2026-05-31T00:00:00.000Z', '');
    `);
    const app = createApp(db);
    const expected = originalList(db, { campaignId: "cmp_large", limit: 20, offset: 0 });

    const response = await app.request("/campaigns/cmp_large/creators");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(expected?.creators[0]?.latest_reach).toBe(18_014_398_509_481_982);
  });

  it("não lê alcance inteiro fora do nicho compatível", async () => {
    const db = trackedDatabase();
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_filter', 'Filtro', '["beleza"]');
      INSERT INTO creators VALUES
        ('crt_compatible', 'Compatível', '["beleza"]', ''),
        ('crt_outside', 'Fora do nicho', '["games"]', '');
      INSERT INTO social_accounts VALUES
        ('acc_compatible', 'crt_compatible', 'instagram'),
        ('acc_outside', 'crt_outside', 'instagram');
      INSERT INTO metrics VALUES
        ('met_compatible', 'acc_compatible', 200, '2026-05-31T00:00:00.000Z', ''),
        ('met_outside', 'acc_outside', 9223372036854775807, '2026-05-31T00:00:00.000Z', '');
    `);
    const app = createApp(db);
    const expected = originalList(db, { campaignId: "cmp_filter", limit: 20, offset: 0 });

    const response = await app.request("/campaigns/cmp_filter/creators");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
  });
});
