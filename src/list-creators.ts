import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type ReachRow = { creator_id: string; latest_reach: number | null };
type DeliveryRow = { creator_id: string; n: number };
type CompatibleCreator = Pick<CreatorMatch, "id" | "name" | "niche_score">;

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(
    db,
    "SELECT niches_json FROM campaigns WHERE id = ?",
    input.campaignId,
  );
  if (!campaign) return null;

  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const compatible: CompatibleCreator[] = [];

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore > 0) {
      compatible.push({ id: creator.id, name: creator.name, niche_score: nicheScore });
    }
  }

  if (compatible.length === 0) {
    return { campaign_id: input.campaignId, total: 0, creators: [] };
  }

  const creatorIds = JSON.stringify(compatible.map(({ id }) => id));
  const reachRows = await all<ReachRow>(
    db,
    `WITH ranked_metrics AS (
       SELECT metrics.account_id, metrics.views,
         ROW_NUMBER() OVER (
           PARTITION BY metrics.account_id ORDER BY metrics.captured_at DESC, metrics.id DESC
         ) AS rank
       FROM metrics
       JOIN social_accounts AS eligible_accounts ON eligible_accounts.id = metrics.account_id
       WHERE eligible_accounts.creator_id IN (SELECT value FROM json_each(?))
     )
     SELECT accounts.creator_id, latest.views AS latest_reach
     FROM social_accounts AS accounts
     LEFT JOIN ranked_metrics AS latest
       ON latest.account_id = accounts.id AND latest.rank = 1
     WHERE accounts.creator_id IN (SELECT value FROM json_each(?))
     ORDER BY accounts.rowid`,
    creatorIds,
    creatorIds,
  );
  const deliveryRows = await all<DeliveryRow>(
    db,
    `SELECT creator_id, COUNT(*) AS n
     FROM deliveries
     WHERE creator_id IN (SELECT value FROM json_each(?)) AND delivered_at >= ?
     GROUP BY creator_id`,
    creatorIds,
    deliveriesSince(),
  );

  const reachByCreator = new Map<string, number>();
  for (const { creator_id, latest_reach } of reachRows) {
    reachByCreator.set(creator_id, (reachByCreator.get(creator_id) ?? 0) + Number(latest_reach ?? 0));
  }
  const deliveriesByCreator = new Map(deliveryRows.map(({ creator_id, n }) => [creator_id, Number(n)]));
  const scored = compatible.map((creator): CreatorMatch => ({
    ...creator,
    latest_reach: reachByCreator.get(creator.id) ?? 0,
    deliveries_90d: deliveriesByCreator.get(creator.id) ?? 0,
  }));

  scored.sort(compareCreators);
  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: scored.slice(input.offset, input.offset + input.limit),
  };
}
