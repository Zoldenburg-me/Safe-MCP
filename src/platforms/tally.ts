import type { Config } from "../config.js";

export interface TallyProposal {
  id: string;
  onchainId: string;
  status: string;
  metadata: { title: string; description: string } | null;
  start: { timestamp: string } | null;
  end: { timestamp: string } | null;
  quorum: string | null;
  voteStats: Array<{
    type: string;
    votesCount: string;
    votersCount: number;
    percent: number;
  }> | null;
  governor: {
    id: string;
    name: string;
    token: { decimals: number; symbol: string } | null;
  } | null;
  organization: { id: string; name: string; slug: string } | null;
}

export interface TallyOrganization {
  id: string;
  name: string;
  slug: string;
  chainIds: string[];
  governorIds: string[];
}

/**
 * Tally is used for discovery and metadata only. Voting itself goes straight to
 * the Governor contract, so an unset TALLY_API_KEY degrades discovery rather
 * than blocking votes.
 */
function requireApiKey(config: Config): string {
  if (!config.TALLY_API_KEY) {
    throw new Error(
      "TALLY_API_KEY is not set, so Tally proposal discovery is unavailable. " +
        "Get a free key at https://www.tally.xyz/user/api-keys, or vote directly " +
        "with governor_vote using a proposal id you already have."
    );
  }
  return config.TALLY_API_KEY;
}

async function tallyQuery<T>(
  config: Config,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await fetch(config.TALLY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": requireApiKey(config),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `Tally API returned ${response.status} ${response.statusText}: ${await response.text()}`
    );
  }

  const body = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    throw new Error(
      `Tally API query failed: ${body.errors.map((e) => e.message).join("; ")}`
    );
  }

  if (!body.data) throw new Error("Tally API returned no data");

  return body.data;
}

const PROPOSAL_FIELDS = `
  id
  onchainId
  status
  quorum
  metadata { title description }
  start { ... on Block { timestamp } ... on BlocklessTimestamp { timestamp } }
  end { ... on Block { timestamp } ... on BlocklessTimestamp { timestamp } }
  voteStats { type votesCount votersCount percent }
  governor { id name token { decimals symbol } }
  organization { id name slug }
`;

/** Resolves a Tally organization slug, e.g. "uniswap", to its ids. */
export async function getOrganization(
  config: Config,
  slug: string
): Promise<TallyOrganization> {
  const query = `
    query Organization($slug: String!) {
      organization(input: { slug: $slug }) {
        id
        name
        slug
        chainIds
        governorIds
      }
    }
  `;

  const data = await tallyQuery<{ organization: TallyOrganization | null }>(
    config,
    query,
    { slug }
  );

  if (!data.organization) {
    throw new Error(`No Tally organization found for slug "${slug}"`);
  }

  return data.organization;
}

export async function listProposals(
  config: Config,
  args: {
    organizationSlug?: string;
    organizationId?: string;
    governorId?: string;
    limit: number;
  }
): Promise<TallyProposal[]> {
  let organizationId = args.organizationId;

  if (!organizationId && !args.governorId) {
    if (!args.organizationSlug) {
      throw new Error(
        "Provide one of organizationSlug, organizationId or governorId."
      );
    }
    organizationId = (await getOrganization(config, args.organizationSlug)).id;
  }

  const query = `
    query GovernanceProposals($input: ProposalsInput!) {
      proposals(input: $input) {
        nodes { ... on Proposal { ${PROPOSAL_FIELDS} } }
      }
    }
  `;

  const filters = args.governorId
    ? { governorId: args.governorId }
    : { organizationId };

  const data = await tallyQuery<{ proposals: { nodes: TallyProposal[] } }>(
    config,
    query,
    {
      input: {
        filters,
        sort: { sortBy: "id", isDescending: true },
        page: { limit: args.limit },
      },
    }
  );

  return data.proposals?.nodes ?? [];
}

/** Fetches a single proposal by its Tally id or its on-chain id. */
export async function getProposal(
  config: Config,
  args: { id?: string; onchainId?: string; governorId?: string }
): Promise<TallyProposal> {
  if (!args.id && !(args.onchainId && args.governorId)) {
    throw new Error(
      "Provide either id, or both onchainId and governorId."
    );
  }

  const query = `
    query Proposal($input: ProposalInput!) {
      proposal(input: $input) { ${PROPOSAL_FIELDS} }
    }
  `;

  const input = args.id
    ? { id: args.id }
    : { onchainId: args.onchainId, governorId: args.governorId };

  const data = await tallyQuery<{ proposal: TallyProposal | null }>(config, query, {
    input,
  });

  if (!data.proposal) {
    throw new Error(
      `Tally proposal not found for ${JSON.stringify(input)}`
    );
  }

  return data.proposal;
}
