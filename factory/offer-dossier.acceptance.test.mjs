import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {executeFactoryCli, parseFactoryCliArgs} from './cli.mjs';
import {createGhCliPublisherAdapter} from './gh-cli.mjs';
import {
  advanceOfferStage,
  buildOfferDossier,
  identifyOffer,
  loadDossierRelationships,
  relationshipsFromLedger,
} from './offer-dossier.mjs';

const ICP_KEYS = [
  'ts', 'source', 'actor_login', 'actor_role', 'org_type', 'repo',
  'money_relationship', 'note', 'mission_id',
];
const FUNNEL_KEYS = [
  'ts', 'offer_id', 'repo', 'pr_number', 'offer_type', 'stage',
  'maintainer_login', 'note',
];

test('findOpenPullRequests maps one read-only GraphQL response', async () => {
  const transport = async () => { throw new Error('unexpected transport call'); };
  transport.rest = async () => { throw new Error('unexpected REST call'); };
  transport.git = async () => { throw new Error('unexpected git call'); };
  transport.graphql = async ({variables}) => ({
    code: 0,
    httpStatus: 200,
    headers: {'x-ratelimit-remaining': '100'},
    body: {data: {repository: {
      nameWithOwner: `${variables.owner}/${variables.name}`,
      owner: {login: variables.owner, __typename: 'Organization'},
      relationshipPullRequest: {
        mergedBy: {login: 'maintainer-one', __typename: 'User'},
        reviews: {nodes: []},
      },
      pullRequests: {nodes: [{
        number: 7,
        title: 'Verify me',
        url: 'https://github.com/warm/repo/pull/7',
        author: {login: 'newbie'},
        authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-02T00:00:00Z',
        isCrossRepository: true,
        mergeable: 'MERGEABLE',
        reviewDecision: 'REVIEW_REQUIRED',
        reviews: {totalCount: 0},
        commits: {nodes: [{commit: {statusCheckRollup: {state: 'EXPECTED'}}}]},
      }]},
    }}},
  });
  const github = createGhCliPublisherAdapter({transport});

  const result = await github.findOpenPullRequests('warm/repo', {
    limit: 12,
    relationshipPrNumber: 42,
  });

  assert.equal(result.owner_type, 'Organization');
  assert.equal(result.relationship_maintainer_login, 'maintainer-one');
  assert.deepEqual(result.pull_requests, [{
    number: 7,
    title: 'Verify me',
    url: 'https://github.com/warm/repo/pull/7',
    author_login: 'newbie',
    author_association: 'FIRST_TIME_CONTRIBUTOR',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-02T00:00:00Z',
    is_cross_repository: true,
    mergeable: 'MERGEABLE',
    review_decision: 'REVIEW_REQUIRED',
    reviewer_count: 0,
    ci_state: 'EXPECTED',
  }]);
});

test('buildOfferDossier ranks verification pain and appends exact demand schemas', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'offer-dossier-'));
  try {
    const database = path.join(root, 'runs', 'factory', 'factory.sqlite');
    const safetyCalls = [];
    const githubCalls = [];
    const db = {
      database,
      async listWarmRepositories() {
        return [{
          repository: 'warm/repo',
          owner_login: 'warm',
          relationship_pr_number: 43,
          mission_id: 'M-1043',
        }];
      },
    };
    const github = {
      async findOpenPullRequests(repo, options) {
        githubCalls.push({repo, options});
        return {
          owner_login: 'warm',
          owner_type: 'Organization',
          relationship_maintainer_login: 'maintainer-one',
          pull_requests: [
          {
            number: 40, title: 'Pending recent PR', url: 'https://github.com/warm/repo/pull/40',
            author_login: 'four', author_association: 'CONTRIBUTOR',
            created_at: '2026-07-01T00:00:00.000Z', is_cross_repository: true,
            ci_state: 'PENDING', reviewer_count: 0,
          },
          {
            number: 20, title: 'Old reviewed PR', url: 'https://github.com/warm/repo/pull/20',
            author_login: 'two', author_association: 'CONTRIBUTOR',
            created_at: '2026-01-01T00:00:00.000Z', is_cross_repository: true,
            ci_state: 'SUCCESS', reviewer_count: 1,
          },
          {
            number: 10, title: 'First timer waiting for CI', url: 'https://github.com/warm/repo/pull/10',
            author_login: 'one', author_association: 'FIRST_TIME_CONTRIBUTOR',
            created_at: '2026-07-18T00:00:00.000Z', is_cross_repository: true,
            ci_state: 'EXPECTED', reviewer_count: 0,
          },
          {
            number: 30, title: 'Failing stale PR', url: 'https://github.com/warm/repo/pull/30',
            author_login: 'three', author_association: 'CONTRIBUTOR',
            created_at: '2026-06-01T00:00:00.000Z', is_cross_repository: true,
            ci_state: 'FAILURE', reviewer_count: 0,
          },
          ],
        };
      },
    };
    const safety = {
      async request(request) {
        safetyCalls.push({...request, execute: typeof request.execute});
        return request.execute();
      },
    };

    const result = await buildOfferDossier({
      db,
      github,
      safety,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      limit: 25,
      loadLedger: async () => ({receipts: [{
        receipt_id: 'M-1042',
        links: {
          target_repo: 'https://github.com/warm/repo',
          publication_pr: 'https://github.com/warm/repo/pull/42',
        },
        upstream_outcome: {status: 'merged'},
      }]}),
    });

    assert.equal(parseFactoryCliArgs(['dossier', '--db', database, '--limit', '25'], {env: {}}).limit, 25);
    assert.deepEqual(githubCalls, [{repo: 'warm/repo', options: {
      limit: 25, relationshipPrNumber: 43,
    }}]);
    assert.deepEqual(safetyCalls, [{
      kind: 'read', priority: 'discovery_top_up', operation: 'fetch_public_ledger',
      repository: 'northset-oss/verification-pilot', execute: 'function',
    }, {
      kind: 'read', priority: 'discovery_top_up', operation: 'find_open_pull_requests',
      repository: 'warm/repo', execute: 'function',
    }]);
    assert.deepEqual(Object.keys(result.dossiers[0]), [
      'repo', 'owner', 'owner_type', 'maintainer', 'relationship_pr_number', 'best_pr',
      'draft_message', 'runners_up',
    ]);
    assert.equal(result.dossiers[0].draft_message.message_key, 'post_merge');
    assert.equal(result.dossiers[0].draft_message.send_gated, true);
    assert.match(result.dossiers[0].draft_message.message, /PR #10/);
    assert.doesNotMatch(result.dossiers[0].draft_message.message, /[—–]/);
    assert.equal(result.dossiers[0].owner, 'warm');
    assert.equal(result.dossiers[0].owner_type, 'org');
    assert.equal(result.dossiers[0].maintainer, 'maintainer-one');
    assert.equal(result.dossiers[0].best_pr.number, 10);
    assert.match(result.dossiers[0].best_pr['why-it-hurts'], /first-time contributor/);
    assert.deepEqual(result.dossiers[0].runners_up.map((pr) => pr.number), [20, 30, 40]);

    const demand = path.join(root, 'runs', 'demand');
    const dossierFile = JSON.parse(await readFile(path.join(demand, 'offer_dossiers.json'), 'utf8'));
    assert.deepEqual(dossierFile, {
      generated_at: result.generated_at,
      dossiers: result.dossiers,
      verification_prospects: [],
    });

    const icp = JSON.parse((await readFile(path.join(demand, 'icp_log.jsonl'), 'utf8')).trim());
    assert.deepEqual(Object.keys(icp), ICP_KEYS);
    assert.deepEqual(icp, {
      ts: '2026-07-21T12:00:00.000Z', source: 'dossier', actor_login: 'maintainer-one',
      actor_role: 'maintainer', org_type: 'org', repo: 'warm/repo', money_relationship: 'none',
      note: 'Merged Northset publication marks warm/repo as a warm relationship.', mission_id: 'M-1043',
    });

    const funnelPath = path.join(demand, 'offer_funnel.jsonl');
    const identified = JSON.parse((await readFile(funnelPath, 'utf8')).trim());
    assert.deepEqual(Object.keys(identified), FUNNEL_KEYS);
    assert.equal(identified.offer_id, 'OF-warm/repo-10');
    assert.equal(identified.offer_type, 'foreign_pr_verify');
    assert.equal(identified.stage, 'identified');
    assert.equal(identified.maintainer_login, 'maintainer-one');

    const advanced = advanceOfferStage(funnelPath, {
      offer_id: identified.offer_id,
      stage: 'offer_drafted',
      note: 'Draft prepared for operator review.',
      now: () => new Date('2026-07-21T13:00:00.000Z'),
    });
    assert.deepEqual(Object.keys(advanced), FUNNEL_KEYS);
    assert.equal(advanced.stage, 'offer_drafted');
    const funnelLines = (await readFile(funnelPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(funnelLines.length, 2);
    assert.equal(funnelLines[0].stage, 'identified');
    assert.equal(funnelLines[1].stage, 'offer_drafted');

    await buildOfferDossier({
      db,
      github,
      safety,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      limit: 25,
      loadLedger: async () => ({receipts: [{
        receipt_id: 'M-1042',
        links: {
          target_repo: 'https://github.com/warm/repo',
          publication_pr: 'https://github.com/warm/repo/pull/42',
        },
        upstream_outcome: {status: 'merged'},
      }]}),
    });
    assert.equal((await readFile(path.join(demand, 'icp_log.jsonl'), 'utf8')).trim().split('\n').length, 1);
    assert.equal((await readFile(funnelPath, 'utf8')).trim().split('\n').length, 2);
    const relationships = loadDossierRelationships(path.join(demand, 'offer_dossiers.json'));
    assert.equal(relationships.repositories.has('warm/repo'), true);
    assert.equal(relationships.owners.has('warm'), true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('public ledger relationships cover merged and rejected historical receipts', () => {
  const result = relationshipsFromLedger({receipts: [{
    receipt_id: 'M-007',
    links: {
      target_repo: 'https://github.com/warm/repo',
      publication_pr: 'https://github.com/warm/repo/pull/7',
    },
    upstream_outcome: {status: 'merged'},
  }, {
    receipt_id: 'M-008',
    links: {
      target_repo: 'https://github.com/rejected/repo',
      publication_pr: 'https://github.com/rejected/repo/pull/8',
    },
    upstream_outcome: {
      status: 'closed_unmerged',
      link: 'https://github.com/rejected/repo/pull/8#issuecomment-80',
      attribution: 'Linked maintainer review',
    },
  }]});
  assert.deepEqual(result.warm.map((item) => [item.repository, item.relationship_pr_number]), [
    ['warm/repo', 7],
  ]);
  assert.deepEqual(result.rejections.map((item) => [item.repository, item.relationship_pr_number]), [
    ['rejected/repo', 8],
  ]);
});

test('dossier harvests explicit historical rejection signals into repository-scoped prospects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'offer-rejection-harvest-'));
  try {
    const prospects = [];
    const db = {
      database: path.join(root, 'runs', 'factory', 'factory.sqlite'),
      listWarmRepositories: async () => [{
        repository: 'warm/repo', owner_login: 'warm', relationship_pr_number: 7, mission_id: 'M-007',
      }],
      recordVerificationProspect: async (record) => {
        prospects.push(record);
        return record;
      },
    };
    const github = {
      findOpenPullRequests: async () => ({
        owner_login: 'warm', owner_type: 'User', relationship_maintainer_login: 'warm', pull_requests: [],
      }),
      getPullRequestFollowUp: async () => ({
        author_login: 'AysajanE',
        review_decision: 'CHANGES_REQUESTED',
        comments: [],
        reviews: [{
          author_login: 'maintainer', author_type: 'User', author_association: 'OWNER',
          body: 'We do not accept AI-generated patches.', state: 'CHANGES_REQUESTED',
          submitted_at: '2026-07-20T00:00:00Z',
        }],
        threads: [],
      }),
    };
    const safety = {request: async (request) => request.execute()};
    const result = await buildOfferDossier({
      db,
      github,
      safety,
      now: () => new Date('2026-07-21T12:00:00Z'),
      loadLedger: async () => ({receipts: [{
        receipt_id: 'M-007',
        links: {
          target_repo: 'https://github.com/warm/repo',
          publication_pr: 'https://github.com/warm/repo/pull/7',
        },
        upstream_outcome: {status: 'merged'},
      }, {
        receipt_id: 'M-008',
        links: {
          target_repo: 'https://github.com/rejected/repo',
          publication_pr: 'https://github.com/rejected/repo/pull/8',
        },
        upstream_outcome: {status: 'closed_unmerged'},
      }]}),
    });
    assert.deepEqual(prospects, [{
      repository: 'rejected/repo',
      owner: 'rejected',
      reasonCode: 'ai_policy_concern',
      missionId: 'M-008',
      observedAt: '2026-07-20T00:00:00Z',
    }]);
    assert.deepEqual(result.verification_prospects, prospects);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('dossier harvests an exact ledger-linked AI rejection without turning it into a policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'offer-linked-rejection-'));
  try {
    const prospects = [];
    const db = {
      database: path.join(root, 'runs', 'factory', 'factory.sqlite'),
      listWarmRepositories: async () => [],
      recordVerificationProspect: async (record) => {
        prospects.push(record);
        return record;
      },
    };
    const decisionUrl = 'https://github.com/prometheus/client_js/pull/773#issuecomment-4953870322';
    const github = {
      findOpenPullRequests: async () => ({pull_requests: []}),
      getPullRequestFollowUp: async () => ({
        author_login: 'AysajanE',
        comments: [{
          author_login: 'jdmarshall', author_type: 'User', author_association: 'CONTRIBUTOR',
          body: 'My bandwidth for dealing with AI generated PRs has reached its end for today.',
          url: decisionUrl, created_at: '2026-07-13T20:00:00Z',
        }],
        reviews: [],
        threads: [],
      }),
    };
    const result = await buildOfferDossier({
      db,
      github,
      safety: {request: async (request) => request.execute()},
      now: () => new Date('2026-07-21T12:00:00Z'),
      loadLedger: async () => ({receipts: [{
        receipt_id: 'M-014',
        links: {
          target_repo: 'https://github.com/prometheus/client_js',
          publication_pr: 'https://github.com/prometheus/client_js/pull/773',
        },
        upstream_outcome: {
          status: 'closed_unmerged', link: decisionUrl, attribution: 'Linked maintainer review',
        },
      }]}),
    });
    assert.deepEqual(prospects, [{
      repository: 'prometheus/client_js',
      owner: 'prometheus',
      reasonCode: 'ai_rejection',
      missionId: 'M-014',
      observedAt: '2026-07-13T20:00:00Z',
    }]);
    assert.deepEqual(result.verification_prospects, prospects);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('manual offer identification makes self-authored and issue-choice infrastructure ready without sending', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'offer-identify-'));
  try {
    const file = path.join(root, 'offer_funnel.jsonl');
    identifyOffer(file, {
      repo: 'warm/repo',
      pr_number: 17,
      offer_type: 'self_authored_verify',
      maintainer_login: 'maintainer-one',
      note: 'Ready for operator review; not sent.',
      now: () => new Date('2026-07-21T12:00:00.000Z'),
    });
    identifyOffer(file, {
      repo: 'warm/repo',
      pr_number: 0,
      offer_type: 'issue_choice',
      maintainer_login: 'maintainer-one',
      note: 'Ask which issue hurts most; not sent.',
      now: () => new Date('2026-07-21T12:01:00.000Z'),
    });
    identifyOffer(file, {
      repo: 'warm/repo',
      pr_number: 17,
      offer_type: 'self_authored_verify',
      maintainer_login: 'maintainer-one',
      note: 'Duplicate identification must not inflate the funnel.',
    });
    const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map((record) => [record.offer_type, record.stage]), [
      ['self_authored_verify', 'identified'],
      ['issue_choice', 'identified'],
    ]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('dossier subcommand runs the read-only builder and prints its summary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'offer-dossier-cli-'));
  try {
    const database = path.join(root, 'runs', 'factory', 'factory.sqlite');
    const db = {
      database,
      listWarmRepositories: async () => [{
        repository: 'warm/repo', owner_login: 'warm', relationship_pr_number: 42, mission_id: 'M-1042',
      }],
      close() {},
    };
    const github = {findOpenPullRequests: async () => ({pull_requests: []})};
    const safety = {request: async (request) => request.execute()};
    const stdout = {value: '', write(chunk) { this.value += chunk; }};
    const transport = async (request) => request.execute?.();

    const result = await executeFactoryCli(['dossier', '--db', database, '--limit', '5'], {
      env: {},
      stdout,
      dependencies: {
        transport,
        openDb: () => db,
        createSafety: () => safety,
        github,
        buildOfferDossier: (options) => buildOfferDossier({
          ...options,
          loadLedger: async () => ({receipts: [{
            receipt_id: 'M-1042',
            links: {
              target_repo: 'https://github.com/warm/repo',
              publication_pr: 'https://github.com/warm/repo/pull/42',
            },
            upstream_outcome: {status: 'merged'},
          }]}),
        }),
      },
    });

    assert.match(stdout.value, /Offer dossiers: 1 warm repos; 0 named PRs/);
    assert.equal(result.dossiers.length, 1);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
