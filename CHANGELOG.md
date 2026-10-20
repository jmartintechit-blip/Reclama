# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

First public version (planned as 0.1.0).

### Added

- Default interest under Ley 3/2004 with the verified BOE semester rates, calculated in integer cents with one segment per semester, partial payments and an optional agreed rate.
- CSV import with a dry-run preview and per-row issues.
- Claims for one debtor with frozen figures, a configurable 40 EUR compensation (per claim, per invoice or none), and cancellation.
- Formal payment-demand letter as a PDF.
- Escalation guide (reminder, formal demand, burofax, monitorio) with a step log and fixed text templates.
- Email sending through Resend, sandbox by default, with idempotency keys and daily quotas.
- Accounts with argon2id passwords and server-side sessions, plus a per-visitor demo sandbox with fictitious data.
- React web app in Spanish with a dashboard, invoice breakdown, claim screens and a strict content security policy.
- English README, architecture document with decision records, and CI (lint, types, tests, rate-table check, build).

### Known limitations

See the [README](README.md#known-limitations).
