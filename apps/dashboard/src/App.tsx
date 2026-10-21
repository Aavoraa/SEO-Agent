import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './context/auth';
import { ProjectProvider } from './context/project';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { LoginPage } from './pages/Login';
import { SetupPage } from './pages/Setup';
import { OverviewPage } from './pages/Overview';
import { PerformancePage } from './pages/Performance';
import { IssuesPage } from './pages/Issues';
import { KeywordsPage } from './pages/Keywords';
import { PagesPage } from './pages/Pages';
import { HeatmapsPage } from './pages/Heatmaps';
import { RecordingsPage } from './pages/Recordings';
import { ContentPage } from './pages/Content';
import { InternalLinksPage } from './pages/InternalLinks';
import { LocalSeoPage } from './pages/LocalSeo';
import { BacklinksPage } from './pages/Backlinks';
import { AiReadinessPage } from './pages/AiReadiness';
import { IntegrationsPage } from './pages/Integrations';
import { SeoAuditPage } from './pages/SeoAudit';
import { CommandCenterPage } from './pages/CommandCenter';
import { OpportunitiesPage } from './pages/Opportunities';
import { OnboardingPage } from './pages/Onboarding';
import { OrganizationPage } from './pages/Organization';
import { AdminPage } from './pages/Admin';
import { SignupPage, AcceptInvitePage } from './pages/Signup';
import { ChangesPage } from './pages/Changes';
import { CompetitorsPage } from './pages/Competitors';
import { RecommendationsPage } from './pages/Recommendations';
import { ApprovalsPage } from './pages/Approvals';
import { ExperimentsPage } from './pages/Experiments';
import { ChangeLogPage } from './pages/ChangeLog';
import { MigrationPage } from './pages/Migration';
import { ReportsPage } from './pages/Reports';
import { AlertsPage } from './pages/Alerts';
import { AiUsagePage } from './pages/AiUsage';
import { SettingsPage } from './pages/Settings';

function Protected() {
  const { user } = useAuth();
  const loc = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return (
    <ProjectProvider key={user.id}>
      <Layout />
    </ProjectProvider>
  );
}

export function App() {
  const { ready, status } = useAuth();
  if (!ready) return <Loading label="Starting…" />;
  return (
    <Routes>
      <Route path="/login" element={status?.needsSetup ? <Navigate to="/setup" replace /> : <LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/invite/:token" element={<AcceptInvitePage />} />
      <Route element={<Protected />}>
        <Route index element={<CommandCenterPage />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="opportunities" element={<OpportunitiesPage />} />
        <Route path="onboarding" element={<OnboardingPage />} />
        <Route path="organization" element={<OrganizationPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="audit" element={<SeoAuditPage />} />
        <Route path="performance" element={<PerformancePage />} />
        <Route path="issues" element={<IssuesPage />} />
        <Route path="keywords" element={<KeywordsPage />} />
        <Route path="pages" element={<PagesPage />} />
        <Route path="pages/:pageId" element={<PagesPage />} />
        <Route path="content" element={<ContentPage />} />
        <Route path="internal-links" element={<InternalLinksPage />} />
        <Route path="local" element={<LocalSeoPage />} />
        <Route path="backlinks" element={<BacklinksPage />} />
        <Route path="heatmaps" element={<HeatmapsPage />} />
        <Route path="recordings" element={<RecordingsPage />} />
        <Route path="ai-readiness" element={<AiReadinessPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="competitors" element={<CompetitorsPage />} />
        <Route path="recommendations" element={<RecommendationsPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="experiments" element={<ExperimentsPage />} />
        <Route path="changes" element={<ChangesPage />} />
        <Route path="change-log" element={<ChangeLogPage />} />
        <Route path="migration" element={<MigrationPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="ai-usage" element={<AiUsagePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
