"""Resource policy for private SQLite update projections and row transport.

Totals bound a database, not an individual allocation. Native row relays use
this same total; frame/chunk limits and stage deadlines remain independent.
"""

SQLITE_TOTAL_BYTES = 1024 * 1024 * 1024
SQLITE_VALUE_BYTES = 256 * 1024 * 1024
