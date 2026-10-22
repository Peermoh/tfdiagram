// Search GitHub for repositories that hold Terraform.

const SORTS = new Set(['best', 'stars', 'updated']);
const CLOUD_WORDS = { aws: 'aws', azure: 'azure' };

// GitHub's search syntax: free words plus qualifiers. Terraform repos are detected by language (HCL).
export function buildQuery({ q = '', hcl = true, cloud = 'any' } = {}) {
  const typed = String(q).trim().replace(/\s+/g, ' ');
  if (typed.length > 200) throw new Error('That search is too long');
  // nothing typed: list the popular Terraform repositories (for the chosen cloud)
  const words = typed || 'terraform';
  const parts = [words];
  if (CLOUD_WORDS[cloud] && !(typed || '').toLowerCase().includes(CLOUD_WORDS[cloud])) parts.push(CLOUD_WORDS[cloud]);
  if (hcl) parts.push('language:HCL');
  return parts.join(' ');
}

export function parseSearchParams(params) {
  const sort = params.get('sort') ?? 'stars';
  const page = Math.min(Math.max(Number(params.get('page') ?? 1) || 1, 1), 10);
  return {
    query: buildQuery({ q: params.get('q') ?? '', hcl: params.get('hcl') !== '0', cloud: params.get('cloud') ?? 'any' }),
    sort: SORTS.has(sort) ? sort : 'stars',
    page,
  };
}

export async function searchRepos({ query, sort, page }, token) {
  const url = new URL('https://api.github.com/search/repositories');
  url.searchParams.set('q', query);
  if (sort !== 'best') { url.searchParams.set('sort', sort); url.searchParams.set('order', 'desc'); }
  url.searchParams.set('per_page', '15');
  url.searchParams.set('page', String(page));
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'tfdiagram', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 || res.status === 429) throw new Error(`GitHub search is rate limited (${token ? 'try again in a minute' : 'about 10 searches a minute without a token: wait a minute or paste a GitHub token'})`);
    if (res.status === 422) throw new Error(`GitHub could not understand that search${body.message ? ` (${body.message})` : ''}`);
    throw new Error(`GitHub search failed (${res.status})`);
  }
  const data = await res.json();
  return {
    total: data.total_count ?? 0,
    page,
    // GitHub only returns the first 1000 results of any search
    hasMore: page * 15 < Math.min(data.total_count ?? 0, 1000),
    items: (data.items ?? []).map((r) => ({
      fullName: r.full_name,
      description: r.description ?? '',
      stars: r.stargazers_count ?? 0,
      updated: r.pushed_at ?? r.updated_at,
      language: r.language ?? '',
      topics: (r.topics ?? []).slice(0, 6),
      url: r.html_url,
      archived: Boolean(r.archived),
    })),
  };
}
