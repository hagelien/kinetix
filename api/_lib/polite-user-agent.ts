/**
 * User-Agent for the scholarly metadata APIs (Crossref, DataCite).
 *
 * Both ask clients to identify themselves with a contact address ("polite
 * pool"): requests that carry one get more reliable service. The address is
 * deployment configuration, not source: set `METADATA_API_MAILTO`. Without it
 * the header still names Kinetix and its site, just without a mailto.
 */
export function politeUserAgent(): string {
  const mailto = process.env.METADATA_API_MAILTO?.trim();
  return mailto
    ? `Kinetix/1.0 (https://kinetix.no; mailto:${mailto})`
    : 'Kinetix/1.0 (https://kinetix.no)';
}
