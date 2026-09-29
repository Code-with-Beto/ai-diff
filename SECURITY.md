# Security policy

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/Code-with-Beto/ai-diff/security/advisories/new) for authentication, authorization, credential exposure, or private-data issues. Do not open a public issue containing an exploit or sensitive information.

Include the affected version or commit, a concise explanation, and reproduction steps using a test account and synthetic repository. Redact credentials, cookies, authorization codes, private repository names, and personal information. A minimal synthetic example is more useful than a raw network trace.

The current `main` branch is maintained. This is a community project without a guaranteed response time.

## Intended boundaries

- GitHub App permissions are Contents read and Metadata read. Contents read technically permits source access; the application requests commit metadata and counts only.
- GitHub tokens remain in encrypted, expiring HttpOnly session cookies, never browser storage or client responses. Refresh tokens are discarded.
- State and PKCE protect sign-in; authenticated mutations validate Origin and a session-bound CSRF token.
- Scan handles are signed and bound to the session, repository, frozen HEAD, and analysis time.
- Results remain in browser memory. Share links contain editable aggregate values in URL fragments and must not be treated as verified attestations.
- Provider infrastructure still processes requests. This policy is not a claim of independent security certification.

See [README-backend.md](README-backend.md) for API details and deployment precautions.
