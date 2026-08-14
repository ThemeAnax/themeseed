# Open questions

Three decisions that need a human answer before v0.1.0 is announced more widely. Each is
recorded with the trade-off and a recommendation, but **none is settled** — the code currently
carries a provisional default that is trivial to change.

---

## 1. License

**Current state:** MIT, in [`LICENSE`](LICENSE) and `package.json`. Provisional.

| Option                     | For                                                                                                                                                                                                    | Against                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **MIT**                    | The default for developer tooling in the npm ecosystem. Shortest path to outside contributions — nobody has to consult legal to send a PR. Matches what most Ghost themes and MCP servers already use. | No explicit patent grant. No defence if someone repackages it commercially.                    |
| **Apache-2.0**             | Explicit patent grant. Requires attribution and change notices, so a rebrand-and-resell is at least visible. Preferred by larger enterprises with formal OSS review.                                   | Longer, and its NOTICE requirements put a small amount of friction on casual contributors.     |
| Something else (BSL, dual) | Protects a commercial offering.                                                                                                                                                                        | Not open source; would undercut the "contributions welcome" framing this repo is built around. |

**Recommendation:** MIT, unless IndiaNIC has a standing policy favouring Apache-2.0. There is no
patentable invention here, and the goal is outside providers for WordPress/Joomla/Drupal/Magento —
which means optimising for the lowest possible barrier to a first PR.

**To change it:** replace `LICENSE`, update the `license` field in `package.json`, and update the
badge line at the bottom of `README.md`. Nothing else references it.

---

## 2. Distribution: private, public, or both

**Current state:** private only. `publishConfig.registry` points at `https://npm.indianic.in/`
and `access` is `restricted`.

Note the spec said `npm.indianic.com`; the registry actually configured on this machine and
serving `@indianic/*` is **`npm.indianic.in`**. That is what the code and docs use. Worth
confirming which is canonical.

| Option                                                       | For                                                                                                                  | Against                                                                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Private only**                                             | Nothing to decide now. Full control over the API surface while it is still v0.x.                                     | "Contributions welcome" in the README is not true if outsiders cannot see the repo. The provider table promises something that cannot happen.         |
| **Public npm + public GitHub**                               | The only way the planned providers actually get written by anyone outside the company. Good visibility for IndiaNIC. | Needs a public GitHub org, an issue triage owner, and a name that is free on public npm (`themeseed` is worth checking). Support expectations follow. |
| **Both** — private `@indianic/themeseed`, public `themeseed` | Internal builds stay controlled; the community gets a package.                                                       | Two release pipelines to keep in step. Realistically drifts unless one is generated from the other.                                                   |

**Recommendation:** decide before announcing. If the OSS framing is real, publish publicly and
keep the private scope as a mirror for internal pinning. If it is not, soften the README —
promising community contributions on a repo nobody can reach is worse than not mentioning it.

**Blocked on this:** the `repository.url` in `package.json` currently points at
`github.com/indianic/themeseed`, which does not exist yet.

---

## 3. Which stock image provider to standardise on

**Current state:** all three implemented behind one adapter interface. Selection is automatic —
whichever key is present, falling back to keyless Lorem Picsum.

| Provider         | Key      | Free tier                               | Query-relevant | Notes                                                                                  |
| ---------------- | -------- | --------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| **Unsplash**     | required | 50 req/hour (demo), 5,000/hour approved | yes            | Best-looking editorial photography. Production use needs app approval and attribution. |
| **Pexels**       | required | 200 req/hour, 20k/month                 | yes            | More generous limits, no approval step. Library skews more stock-like.                 |
| **Lorem Picsum** | none     | unmetered                               | **no**         | Real photographs at exact dimensions, but no search — results are topically random.    |

The relevant limit is small: a 15-post seed run makes roughly 15–25 image requests. Unsplash's
50/hour demo tier is enough for two or three runs an hour, which is fine for a developer and not
fine for a CI job.

**Recommendation:** keep all three. The adapter already exists, the cost of keeping it is a
single `switch`, and each covers a case the others do not — Unsplash for the demo you show a
client, Pexels when you are iterating and hitting rate limits, Picsum when you have no key and
only care about layout.

The question worth answering is narrower: **should IndiaNIC hold a shared Unsplash production
key?** That would make good imagery the default rather than something each developer configures.
It also means a shared secret to distribute, which is a real cost.

**If a single provider must be chosen:** Pexels — the rate limit is the thing that actually
bites, and it needs no approval process.

---

## Not open questions

For the record, these were decided during the build and are documented in the code:

- **`commander` + `@clack/prompts`** for the CLI. Conventional `--help`/`--version` behaviour for
  free; clack degrades to plain output on a non-TTY, which the seed command needs.
- **Ghost theme analysis reads the rendered stylesheet** rather than the Admin API, because
  `GET /ghost/api/admin/themes/` returns 403 for API-token auth on every Ghost version.
- **The default content engine is template-based, not model-based.** Deterministic, offline, no
  key, no cost. Better prose is available by passing `titles` or implementing `ContentEngine`.
- **The `ai` image source falls back to a procedural generator** when no key is configured, and
  labels every image it produces as a placeholder rather than as generated art.
