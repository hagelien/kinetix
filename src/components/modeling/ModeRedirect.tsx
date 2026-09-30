import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { buildModelingUrl, type ModelingMode } from '@/lib/modelingMode';

interface Props {
  mode: ModelingMode;
}

/**
 * Permanent redirect from a legacy modeling path (`/simulator`,
 * `/simulator/ethanol`, `/kinelab`) to the unified `/modeling?mode=...`.
 *
 * Preserves both the search params AND the URL hash:
 *  - Search params: `buildSimulatorUrl` embedded `drugId`, `conc`,
 *    `concUnit` — external bookmarks and wiki references rely on them
 *    landing on the new page. A bare `<Navigate>` would silently drop them.
 *  - Hash: legacy ethanol scenario links use `#scenario=...`; the unified
 *    simulator bridge reads it and creates an ethanol component.
 *    Dropping the hash would silently load the default case instead of
 *    the saved one, breaking shared/saved URLs.
 *
 * `replace: true` so the redirect doesn't add a back-button hop.
 */
export function ModeRedirect({ mode }: Props) {
  const [searchParams] = useSearchParams();
  const { hash } = useLocation();
  const target = buildModelingUrl(mode, searchParams);
  return <Navigate to={hash ? `${target}${hash}` : target} replace />;
}
