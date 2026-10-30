"""Publication-date eligibility shared by the runner and finalizer.

Bounds are inclusive ISO dates. Partial paper dates describe an interval;
only intervals wholly inside the requested window are eligible. No network or
model call is needed, and an unconstrained request keeps the original pool.
"""

import calendar
from datetime import date
import re


MONTHS = {name.casefold(): number for number, name in enumerate(calendar.month_name) if name}
MONTHS.update({name.casefold(): number for number, name in enumerate(calendar.month_abbr) if name})
MONTH_NAMES = "|".join(sorted(MONTHS, key=len, reverse=True))


def date_interval(value):
    """Read a supported year/month/day (or ISO timestamp) as a date interval."""
    if value is None or isinstance(value, bool):
        raise ValueError("a publication date must be a year, month, or ISO date")
    text = str(value).strip()
    text = re.sub(r"[T ]\d{2}:\d{2}:\d{2}.*$", "", text)
    english = re.fullmatch(
        r"(" + MONTH_NAMES + r")\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?[, ]+)?(\d{4})",
        text, re.I,
    )
    if english:
        year = int(english[3])
        month = MONTHS[english[1].casefold()]
        day = int(english[2]) if english[2] else None
    else:
        text = re.sub(r"\s+", "", text)
        text = text.replace("年", "-").replace("月", "-").replace("/", "-")
        text = text.rstrip("-日号")
        if re.fullmatch(r"\d{6}|\d{8}", text):
            text = text[:4] + "-" + text[4:6] + ("-" + text[6:] if len(text) == 8 else "")
        match = re.fullmatch(r"(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?", text)
        if not match:
            raise ValueError("unsupported publication date: %s" % value)
        year, month, day = (int(part) if part else None for part in match.groups())
    if not 1900 <= year <= 2100:
        raise ValueError("publication year must be between 1900 and 2100")
    if month is None:
        return date(year, 1, 1), date(year, 12, 31)
    first = date(year, month, day or 1)
    last = first if day else date(year, month, calendar.monthrange(year, month)[1])
    return first, last


def resolve(plan=None):
    """Validate/intersect only agent-declared inclusive bounds, never user prose.

    The planning agent owns time semantics, hard versus soft preferences, and
    omitted/negated conditions. Code only validates dates and executes them.
    """
    plan = {} if plan is None else plan
    if not isinstance(plan, dict):
        raise ValueError('publication bounds must be an object')
    bounds = []
    for key, side in (('date_start', 'start'), ('year_start', 'start'),
                      ('date_end', 'end'), ('year_end', 'end')):
        if plan.get(key) is not None:
            value = plan[key]
            pattern = r'\d{4}-\d{2}-\d{2}' if key.startswith('date_') else r'\d{4}'
            if isinstance(value, bool) or not re.fullmatch(pattern, str(value)):
                raise ValueError('%s must be %s' % (
                    key, 'an ISO date (YYYY-MM-DD)' if key.startswith('date_') else 'a four-digit year',
                ))
            first, last = date_interval(plan[key])
            bounds.append((side, first if side == 'start' else last))
    starts = [value for side, value in bounds if side == 'start']
    ends = [value for side, value in bounds if side == 'end']
    start, end = max(starts, default=None), min(ends, default=None)
    if start and end and start > end:
        raise ValueError('publication date_start exceeds date_end')
    if not start and not end:
        return {}
    return {key: value.isoformat() for key, value in (('date_start', start), ('date_end', end)) if value}


def apply_to_plan(plan):
    """Apply server date/year bounds and retain exact bounds for local checks."""
    plan = dict(plan)
    window = resolve(plan)
    if not window:
        return plan, window
    plan.update(window)
    queries = []
    for source in plan.get('queries', []):
        item = {'query': source} if isinstance(source, str) else dict(source)
        # The service supports query_string ranges, not standalone date_start
        # payload fields. Filter before its relevance ranking / limit; keep
        # the original per-query limits and avoid another retrieval round.
        if str(item.get('mode', 'keyword')).strip().lower() == 'keyword':
            keyword = item.get('query', '')
            if not isinstance(keyword, str) or not keyword.strip():
                raise ValueError('keyword query must be a nonempty string')
            start, end = window.get('date_start', '*'), window.get('date_end', '*')
            item['query'] = '(%s) AND publicationdate:[%s TO %s]' % (keyword, start, end)
        for date_key, year_key, combine in (
            ('date_start', 'year_start', max), ('date_end', 'year_end', min),
        ):
            if date_key in window:
                year = int(window[date_key][:4])
                item[year_key] = combine(year, int(item[year_key])) if item.get(year_key) is not None else year
        queries.append(item)
    plan['queries'] = queries
    return plan, window


def _paper_interval(paper):
    raw = paper.get('publication_date') or paper.get('publicationdate')
    if raw:
        try:
            return date_interval(raw)
        except (ValueError, TypeError):
            pass
    try:
        return date_interval(paper.get('year'))
    except (ValueError, TypeError):
        return None


def filter_papers(papers, window):
    """Return eligible papers and auditable counts, without modifying records."""
    stats = {'out_of_range': 0, 'unverified_date': 0}
    if not window:
        return papers, stats
    start = date.fromisoformat(window['date_start']) if window.get('date_start') else date.min
    end = date.fromisoformat(window['date_end']) if window.get('date_end') else date.max
    eligible = []
    for paper in papers:
        interval = _paper_interval(paper)
        if interval is None:
            stats['unverified_date'] += 1
        elif interval[1] < start or interval[0] > end:
            stats['out_of_range'] += 1
        elif interval[0] < start or interval[1] > end:
            stats['unverified_date'] += 1
        else:
            eligible.append(paper)
    return eligible, stats
