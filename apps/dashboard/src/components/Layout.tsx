import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { AlertTriangle, LogOut, Menu, X } from 'lucide-react';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { humanize } from '../lib/format';
import { Sidebar } from './Sidebar';
import { CommandPalette } from './CommandPalette';
import { ErrorBoundary } from './ErrorBoundary';
import { ErrorBox, Loading } from './ui';
import { EmptyState } from './EmptyState';

const WORKSPACE_PATHS = ['/onboarding', '/organization', '/admin'];

export function DemoBanner() {
  return (
    <div className="flex h-[29px] items-center justify-center gap-2 overflow-hidden border-b border-amber-300 bg-amber-100 px-4 text-xs font-semibold tracking-wide whitespace-nowrap text-amber-900" role="status">
      <AlertTriangle className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">DEMO MODE — sample data, not real customer performance</span>
      <span className="sm:hidden">DEMO MODE — sample data, not real performance</span>
    </div>
  );
}

export function Layout() {
  const { user, role, isPlatformAdmin, status, signOut, organizations } = useAuth();
  const { projects, projectId, project, selectProject, loading, error } = useProject();
  const [navOpen, setNavOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setNavOpen(false), [loc.pathname]);

  const demo = !!status?.demoMode || !!project?.is_demo || !!projects.find((p) => p.id === projectId)?.is_demo;

  return (
    <div className="flex min-h-screen flex-col">
      <CommandPalette />
      {demo && <div className="sticky top-0 z-30"><DemoBanner /></div>}
      <div className="flex flex-1">
        {/* Desktop sidebar */}
        <aside className={`fixed bottom-0 left-0 z-20 hidden w-60 border-r border-gray-200 bg-white lg:block ${demo ? 'top-[29px]' : 'top-0'}`}>
          <Sidebar />
        </aside>
        {/* Mobile / tablet drawer */}
        {navOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-gray-900/30" onClick={() => setNavOpen(false)} />
            <aside className="relative h-full w-64 bg-white shadow-xl">
              <button className="absolute top-4 right-3 text-gray-400" onClick={() => setNavOpen(false)} aria-label="Close menu">
                <X className="h-5 w-5" />
              </button>
              <Sidebar onNavigate={() => setNavOpen(false)} />
            </aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
          <header className={`sticky z-10 flex h-14 items-center gap-3 border-b border-gray-200 bg-white/95 px-4 backdrop-blur lg:px-6 ${demo ? 'top-[29px]' : 'top-0'}`}>
            <button className="rounded p-1 text-gray-500 hover:bg-gray-100 lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex min-w-0 items-center gap-2">
              {projects.length > 1 ? (
                <select className="input max-w-72 font-medium" value={projectId ?? ''} onChange={(e) => selectProject(e.target.value)} aria-label="Project">
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="truncate text-sm font-medium text-gray-900">{project?.name ?? projects[0]?.name ?? '—'}</span>
              )}
              {project?.websites?.[0]?.base_url && (
                <a href={project.websites[0].base_url} target="_blank" rel="noopener noreferrer" className="hidden truncate text-xs text-gray-500 hover:text-gray-700 md:inline">
                  {project.websites[0].base_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                </a>
              )}
            </div>
            <div className="ml-auto flex items-center gap-3">
              {user && (
                <div className="hidden text-right leading-tight sm:block">
                  <div className="text-xs font-medium text-gray-900">{user.name || user.email}</div>
                  <div className="text-[11px] text-gray-500">{isPlatformAdmin ? 'Platform admin' : `${humanize(role)} on this project`}</div>
                </div>
              )}
              <button onClick={signOut} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-300 px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-50" title="Sign out">
                <LogOut className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          </header>
          <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 lg:px-6">
            {WORKSPACE_PATHS.some((p) => loc.pathname.startsWith(p)) ? (
              // Workspace pages (onboarding, organization, admin) work without a selected project.
              <ErrorBoundary resetKey={loc.pathname}>
                <Outlet />
              </ErrorBoundary>
            ) : error && !project ? (
              <ErrorBox error={new Error(error)} onRetry={() => window.location.reload()} />
            ) : !projectId && !loading ? (
              isPlatformAdmin || organizations.some((o) => ['owner', 'admin', 'manager'].includes(o.role)) ? (
                <EmptyState title="Add your first website" description="We detect the technology, run a baseline audit and show your first opportunities." action={<Link to="/onboarding" className="inline-flex items-center rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">Add website</Link>} />
              ) : (
                <EmptyState title="No projects shared with you yet" description="Ask an admin of your organization to give you access." />
              )
            ) : !project ? (
              <Loading />
            ) : (
              <ErrorBoundary resetKey={loc.pathname}>
                <Outlet />
              </ErrorBoundary>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
