// Tiny API client with token + profile handling.
let token = localStorage.getItem('nebula_token') || '';
let profileId = Number(localStorage.getItem('nebula_profile')) || 0;

export function setToken(t) {
  token = t || '';
  if (t) localStorage.setItem('nebula_token', t);
  else localStorage.removeItem('nebula_token');
}
export function getToken() { return token; }

export function setProfile(id) {
  profileId = Number(id) || 0;
  if (profileId) localStorage.setItem('nebula_profile', String(profileId));
  else localStorage.removeItem('nebula_profile');
}
export function getProfile() { return profileId; }

/** Route TMDB images through the server's disk cache. */
export function img(src) {
  if (!src) return src;
  if (/^https:\/\/image\.tmdb\.org\//.test(src)) return '/api/img?src=' + encodeURIComponent(src);
  return src;
}

async function request(method, url, body) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (profileId) headers['X-Nebula-Profile'] = String(profileId);
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api' + url, {
    method, headers,
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { }
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const withToken = (url) =>
  token ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : url;

/** Cached thumbnail URL, cache-busted by the media row's updatedAt so freshly
 *  generated art refetches automatically without a manual reload. */
export const thumbUrl = (id, v) => withToken(`/api/thumb/${id}.jpg` + (v ? `?v=${v}` : ''));

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
  streamUrl: (id) => `/api/stream/${id}` + (token ? `?token=${encodeURIComponent(token)}` : ''),
};
