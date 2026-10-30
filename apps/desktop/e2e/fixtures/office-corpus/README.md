# Office E2E corpus

These three synthetic documents are committed so `ci:test` and the Office Playwright tests do not need LibreOffice on the runner. The DOC contains repeated selection text across multiple pages; the DOCX is a longer document; the XLS has 120 data rows. `manifest.json` pins the exact bytes with SHA-256.

The default corpus is this directory. `SCHOLARSEED_OFFICE_CORPUS` and `SCHOLARSEED_OFFICE_CORPUS_MANIFEST` can select a different versioned corpus, but both must be supplied together. Model credentials and SkillHub configuration remain separate prerequisites for their respective CI stages.

To regenerate the committed files on a maintenance machine with LibreOffice installed, run `SOFFICE=/path/to/soffice node scripts/ci/generate-office-corpus.cjs` from the repository root. Regeneration may change hashes because the converter embeds document metadata; review the resulting binaries and manifest together.
