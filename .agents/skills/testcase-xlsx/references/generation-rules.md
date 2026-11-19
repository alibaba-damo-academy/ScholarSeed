# Test Case Generation Rules

- Use requirements and acceptance criteria as primary inputs. Use defect evidence to define the regression target. Designs, screenshots, and flowcharts establish observable controls, text, paths, and states. Record conflicts and avoid inferring backend behavior.
- Map source rules to cases before splitting cases by observable behavior. Cover entry points, loading, main and alternate flows, empty and error states, limits, repeated submissions, permission changes, recovery, and material data or copy where applicable.
- Give each row one main objective. Match steps to expected results and state the user, page, and data preconditions.
- Follow the caller's asset conventions for `author`, `folder`, IDs, and `tag`. Tags may represent requirements, designs, defects, or regressions.
- Use P0 for release-blocking failures, P1 for core flows and permissions, P2 for secondary interactions and recovery, and P3 for low-risk presentation.
- Maintain JSON as the source. Keep existing IDs and check duplicate IDs, required fields, and priorities before export. Verify the sheet, 12 headers, row count, and required fields with openpyxl after export.
