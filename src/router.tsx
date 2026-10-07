import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { Routes, Route } from 'react-router-dom';
import { RootLayout } from './components/RootLayout';
import { AuthGuard } from './components/AuthGuard';
import { ModeRedirect } from './components/modeling/ModeRedirect';
import { useAuthStore } from './stores/authStore';
import { useAppStore } from './stores/appStore';
import { normalizeEthanolUnit } from './lib/ethanolUnits';

const App = lazy(() => import('./App'));
const PatternCasePage = lazy(() =>
  import('./pages/PatternCasePage').then((m) => ({ default: m.PatternCasePage })),
);
const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })),
);
const AdminPage = lazy(() =>
  import('./pages/AdminPage').then((module) => ({ default: module.AdminPage })),
);
const ModelingPage = lazy(() =>
  import('./pages/ModelingPage').then((module) => ({
    default: module.ModelingPage,
  })),
);
const SimulatorMechanicsPage = lazy(() =>
  import('./pages/SimulatorMechanicsPage').then((module) => ({
    default: module.SimulatorMechanicsPage,
  })),
);
const WikiLayout = lazy(() =>
  import('./pages/wiki/WikiLayout').then((module) => ({
    default: module.WikiLayout,
  })),
);
const WikiHome = lazy(() =>
  import('./pages/wiki/WikiHome').then((module) => ({
    default: module.WikiHome,
  })),
);
const WikiPage = lazy(() =>
  import('./pages/wiki/WikiPage').then((module) => ({
    default: module.WikiPage,
  })),
);
const WikiEdit = lazy(() =>
  import('./pages/wiki/WikiEdit').then((module) => ({
    default: module.WikiEdit,
  })),
);
const WikiNew = lazy(() =>
  import('./pages/wiki/WikiNew').then((module) => ({
    default: module.WikiNew,
  })),
);
const WikiHistory = lazy(() =>
  import('./pages/wiki/WikiHistory').then((module) => ({
    default: module.WikiHistory,
  })),
);
const EntityMonograph = lazy(() =>
  import('./pages/wiki/EntityMonograph').then((module) => ({
    default: module.EntityMonograph,
  })),
);
const DrugPreview = lazy(() =>
  import('./pages/wiki/DrugPreview').then((module) => ({
    default: module.DrugPreview,
  })),
);
const ReviewPage = lazy(() =>
  import('./pages/ReviewPage').then((module) => ({
    default: module.ReviewPage,
  })),
);
const ComparisonPage = lazy(() =>
  import('./pages/ComparisonPage').then((module) => ({
    default: module.ComparisonPage,
  })),
);
const MethodsPage = lazy(() =>
  import('./pages/MethodsPage').then((module) => ({
    default: module.MethodsPage,
  })),
);
const DetectionTimesPage = lazy(() =>
  import('./pages/DetectionTimesPage').then((module) => ({
    default: module.DetectionTimesPage,
  })),
);
const EntitiesPage = lazy(() =>
  import('./pages/EntitiesPage').then((module) => ({
    default: module.EntitiesPage,
  })),
);
const MethodDetailPage = lazy(() =>
  import('./pages/MethodDetailPage').then((module) => ({
    default: module.MethodDetailPage,
  })),
);
const MethodBasketPage = lazy(() =>
  import('./pages/MethodBasketPage').then((module) => ({
    default: module.MethodBasketPage,
  })),
);
const PreferencesPage = lazy(() =>
  import('./pages/PreferencesPage').then((module) => ({
    default: module.PreferencesPage,
  })),
);
const ReferencePage = lazy(() =>
  import('./pages/ReferencePage').then((module) => ({
    default: module.ReferencePage,
  })),
);
const ReferencesPage = lazy(() =>
  import('./pages/ReferencesPage').then((module) => ({
    default: module.ReferencesPage,
  })),
);
const PdfRequestsPage = lazy(() =>
  import('./pages/PdfRequestsPage').then((module) => ({
    default: module.PdfRequestsPage,
  })),
);
const PdfInboxPage = lazy(() =>
  import('./pages/PdfInboxPage').then((module) => ({
    default: module.PdfInboxPage,
  })),
);
const PaperExtractionQueuePage = lazy(() =>
  import('./pages/PaperExtractionQueuePage').then((module) => ({
    default: module.PaperExtractionQueuePage,
  })),
);
const SourceLibraryPage = lazy(() =>
  import('./pages/learn/SourceLibraryPage').then((module) => ({
    default: module.SourceLibraryPage,
  })),
);
const LearningUnitPage = lazy(() =>
  import('./pages/learn/LearningUnitPage').then((module) => ({
    default: module.LearningUnitPage,
  })),
);
const TopicMapPage = lazy(() =>
  import('./pages/learn/TopicMapPage').then((module) => ({
    default: module.TopicMapPage,
  })),
);
const MyPathPage = lazy(() =>
  import('./pages/learn/MyPathPage').then((module) => ({
    default: module.MyPathPage,
  })),
);
const LearnReviewPage = lazy(() =>
  import('./pages/learn/ReviewPage').then((module) => ({
    default: module.ReviewPage,
  })),
);

function withRouteFallback(element: ReactNode) {
  return (
    <Suspense
      fallback={
        <div className="flex-1 px-6 py-12 text-center text-sm text-muted-foreground">
          Loading...
        </div>
      }
    >
      {element}
    </Suspense>
  );
}

// #310: routes that require any authenticated session. Anonymous visitors
// are redirected to /login. The drug table at "/" and citation reference
// detail pages stay public so source links do not dead-end at login.
function withAuthRequired(element: ReactNode) {
  return <AuthGuard>{withRouteFallback(element)}</AuthGuard>;
}

export function AppRouter() {
  const checkAuth = useAuthStore((s) => s.checkAuth);
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Mirror the server-side enabled-unit list into the localStorage-backed
  // app store whenever the authenticated user changes — anonymous visitors
  // keep whatever their browser stored last (#306).
  const enabledUnits = useAuthStore(
    (s) => s.user?.enabledConcentrationUnits ?? null,
  );
  const setEnabledUnits = useAppStore((s) => s.setEnabledUnits);
  useEffect(() => {
    if (enabledUnits && enabledUnits.length > 0) {
      setEnabledUnits(enabledUnits as Parameters<typeof setEnabledUnits>[0]);
    }
  }, [enabledUnits, setEnabledUnits]);
  // Ethanol's own display unit, mirrored the same way.
  const ethanolUnit = useAuthStore(
    (s) => s.user?.ethanolConcentrationUnit ?? null,
  );
  const setEthanolUnit = useAppStore((s) => s.setEthanolUnit);
  useEffect(() => {
    if (ethanolUnit) setEthanolUnit(normalizeEthanolUnit(ethanolUnit));
  }, [ethanolUnit, setEthanolUnit]);

  // Reset of user-specific singleton stores on auth identity change is
  // wired in `src/stores/authStore.ts` via a module-level subscribe.
  // That subscribe runs synchronously inside set(), so child components
  // mounting in the same commit cannot race ahead of the reset.

  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route path="/" element={withRouteFallback(<App />)} />
        <Route path="/modeling" element={withAuthRequired(<ModelingPage />)} />
        {/* "How the simulator works" — the behind-the-scenes account of the
            modelling module's premises, assumptions, constraints and known
            weaknesses, written for a pharmacologist reviewing whether a curve may
            be relied on. Kept lazy: it pulls the markdown document and the registry
            inventory, which nobody should pay for until they open it. Same auth as
            /modeling — it describes that workspace. */}
        <Route
          path="/modeling/how-it-works"
          element={withAuthRequired(<SimulatorMechanicsPage />)}
        />
        {/* Linked from the primary nav (Header) as "Metabolite profile".
            Kept lazy: the pattern engine reads the whole embedded catalog for
            molecular weights, which nobody should pay for until they open it. */}
        <Route
          path="/modeling/pattern"
          element={withAuthRequired(<PatternCasePage />)}
        />
        {/* The saved case, so a reload or a shared link opens what was filed
            rather than a fresh draft. Same component: the id is the only
            difference between entering a case and reopening one. */}
        <Route
          path="/modeling/pattern/:caseId"
          element={withAuthRequired(<PatternCasePage />)}
        />
        {/* Legacy paths — redirect to /modeling?mode=… while preserving
            search params (drugId, conc, concUnit, etc). External
            bookmarks and wiki links may still reference these. */}
        <Route path="/simulator" element={<ModeRedirect mode="simulator" />} />
        <Route
          path="/simulator/ethanol"
          element={<ModeRedirect mode="ethanol" />}
        />
        <Route path="/kinelab" element={<ModeRedirect mode="kinelab" />} />
        <Route
          path="/comparison"
          element={withAuthRequired(<ComparisonPage />)}
        />
        <Route path="/methods" element={withAuthRequired(<MethodsPage />)} />
        <Route path="/entities" element={withAuthRequired(<EntitiesPage />)} />
        {/* Detection times ("påvisningstider"): one substance, every matrix.
            `?drug=<id>` is the whole state, so a looked-up substance is a
            link someone can paste into a case note. */}
        <Route
          path="/detection-times"
          element={withAuthRequired(<DetectionTimesPage />)}
        />
        <Route path="/learn" element={withAuthRequired(<SourceLibraryPage />)} />
        <Route path="/learn/map" element={withAuthRequired(<TopicMapPage />)} />
        <Route path="/learn/path" element={withAuthRequired(<MyPathPage />)} />
        <Route
          path="/learn/review"
          element={withAuthRequired(<LearnReviewPage />)}
        />
        <Route
          path="/learn/unit/:id"
          element={withAuthRequired(<LearningUnitPage />)}
        />
        <Route
          path="/methods/basket"
          element={withAuthRequired(<MethodBasketPage />)}
        />
        <Route
          path="/methods/:id"
          element={withAuthRequired(<MethodDetailPage />)}
        />
        <Route path="/wiki" element={withAuthRequired(<WikiLayout />)}>
          <Route index element={withRouteFallback(<WikiHome />)} />
          <Route path="new" element={withRouteFallback(<WikiNew />)} />
          {/* `:tab` is a drug monograph's sub-page (pharmacokinetics,
              postmortem, …). One optional-segment route, so moving between
              tabs never remounts the page. Static siblings (`:slug/edit`,
              `:slug/history`, `drug/…`, `entity/…`) outrank it. */}
          <Route path=":slug/:tab?" element={withRouteFallback(<WikiPage />)} />
          <Route path=":slug/edit" element={withRouteFallback(<WikiEdit />)} />
          <Route
            path=":slug/history"
            element={withRouteFallback(<WikiHistory />)}
          />
          <Route
            path="drug/:drugId"
            element={withRouteFallback(<DrugPreview />)}
          />
          <Route
            path="entity/:slug"
            element={withRouteFallback(<EntityMonograph />)}
          />
        </Route>
        <Route path="/review" element={withRouteFallback(<ReviewPage />)} />
        <Route path="/login" element={withRouteFallback(<LoginPage />)} />
        <Route path="/admin" element={withRouteFallback(<AdminPage />)} />
        <Route
          path="/references"
          element={withRouteFallback(<ReferencesPage />)}
        />
        <Route
          path="/references/:referenceId"
          element={withRouteFallback(<ReferencePage />)}
        />
        <Route
          path="/pdf-requests"
          element={withAuthRequired(<PdfRequestsPage />)}
        />
        {/* Bulk drop-off: PDFs arrive here unattached and are linked to their
            citations afterwards. The page guards on the capabilities itself;
            the route only requires a session, as /pdf-requests does. */}
        <Route
          path="/pdf-inbox"
          element={withAuthRequired(<PdfInboxPage />)}
        />
        {/* Editor/admin-only: queue an uploaded full-text paper for the
            scheduled fact-extraction agent. The page guards on the editor
            role itself; the route only requires a session. */}
        <Route
          path="/paper-extraction"
          element={withAuthRequired(<PaperExtractionQueuePage />)}
        />
        <Route
          path="/preferences"
          element={withRouteFallback(<PreferencesPage />)}
        />
      </Route>
    </Routes>
  );
}
