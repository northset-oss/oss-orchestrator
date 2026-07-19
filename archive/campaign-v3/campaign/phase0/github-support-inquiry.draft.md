# GitHub Support inquiry — receipt campaign policy fit

Status: **DRAFT — NOT SENT**

Prepared: 2026-07-17

To: GitHub Support

Subject: Request for guidance on a paced, human-approved open-source contribution campaign

Hello GitHub Support,

Northset is preparing an open-source contribution campaign and would appreciate guidance
before increasing its volume. The work is AI-assisted, but a named human reviews and
explicitly approves every contribution batch before any upstream pull request is opened.
We are not asking for a safe harbor; we want to ensure our operating model matches GitHub's
rules and adjust it if GitHub recommends a different approach.

Our proposed model is:

- Aysajan uses one personal GitHub account belonging only to Aysajan. Credentials are not
  shared. A second local reviewer, Shehide, has no access to that account or its credentials.
- Each pull request fixes a specific public issue whose maintainers have invited
  contributions. We do not post bids, promotional issue comments, unsolicited marketing,
  or repeated messages. A pull request body contains one factual link to its own test
  receipt.
- Every candidate is rechecked before publication. We stop immediately on an opt-out,
  repository-specific restriction, or maintainer request to withdraw.
- Initial pacing is at most 15 new pull requests per day and at most 2 per hour, with no
  more than 2 new pull requests per repository owner per day and 5 open pull requests per
  owner. Any later increase is gated on observed maintainer outcomes and follow-up capacity.
- Maintainer messages take priority over new submissions. We target acknowledgement within
  12 hours, a substantive response or status within 24 hours, and a proposed correction or
  reasoned inability within 48 hours.
- Any HTTP 403/429, `Retry-After`, secondary-rate-limit, or model-provider throttle pauses
  the pipeline. There is no automatic resume and no retry hammering.
- Our best-effort campaign objective is about 1,000 externally verifiable receipts, with a
  minimum of 750 authored public contribution receipts and 25 maintainer- or
  organization-authorized verification receipts. That objective is not a promise of daily
  volume and does not override the pacing or stop conditions above.

Could you please advise:

1. Does this human-approved, contribution-specific model align with GitHub's Terms of
   Service and Acceptable Use Policies at the proposed initial pacing?
2. Are there additional anti-spam, account, or repository-owner safeguards you recommend?
3. If we later automate only mechanical publication steps after exact human approval,
   should those actions use a GitHub App, a machine account, or the operator's personal
   account? If an App is preferred, are there particular permission or Marketplace
   requirements we should plan for?
4. Is there a support channel or review process you recommend before any increase above
   30 new pull requests per day?

Sources reviewed while preparing this inquiry:

- GitHub Terms of Service: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- GitHub Acceptable Use Policies: https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies
- REST API rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- App permission changes: https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app
- Marketplace listing requirements: https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app

Thank you,

Aysajan
Northset
