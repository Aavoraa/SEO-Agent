import { NavLink } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Bot,
  CheckSquare,
  ClipboardList,
  FileBarChart,
  FileText,
  FlaskConical,
  Flame,
  GitCompareArrows,
  History,
  KeyRound,
  LayoutDashboard,
  Lightbulb,
  Link2,
  Link as LinkIcon,
  MapPin,
  Settings,
  Gauge,
  Target,
  Building2,
  ShieldCheck,
  Sparkles,
  ScanSearch,
  Rocket,
  PlugZap,
  Swords,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { useProject } from '../context/project';
import { useAuth } from '../context/auth';
import { cx } from '../lib/format';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: 'approvals' | 'alerts';
  platformAdmin?: boolean;
  group: 'Decide' | 'Analyze' | 'Improve' | 'Measure' | 'Workspace';
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Command Center', icon: Gauge, group: 'Decide' },
  { to: '/opportunities', label: 'Opportunities', icon: Target, group: 'Decide' },
  { to: '/approvals', label: 'Approvals', icon: CheckSquare, badge: 'approvals', group: 'Decide' },
  { to: '/changes', label: 'Deployments & Changes', icon: Rocket, group: 'Decide' },
  { to: '/audit', label: 'SEO Audit', icon: ScanSearch, group: 'Analyze' },
  { to: '/overview', label: 'Overview', icon: LayoutDashboard, group: 'Analyze' },
  { to: '/performance', label: 'Performance', icon: BarChart3, group: 'Analyze' },
  { to: '/issues', label: 'SEO Issues', icon: AlertTriangle, group: 'Analyze' },
  { to: '/keywords', label: 'Keywords', icon: KeyRound, group: 'Analyze' },
  { to: '/pages', label: 'Pages', icon: FileText, group: 'Analyze' },
  { to: '/heatmaps', label: 'Heatmaps', icon: Flame, group: 'Analyze' },
  { to: '/recordings', label: 'Recordings', icon: Video, group: 'Analyze' },
  { to: '/ai-readiness', label: 'AI Search', icon: Sparkles, group: 'Analyze' },
  { to: '/competitors', label: 'Competitors', icon: Swords, group: 'Analyze' },
  { to: '/content', label: 'Content', icon: ClipboardList, group: 'Improve' },
  { to: '/internal-links', label: 'Internal Links', icon: Link2, group: 'Improve' },
  { to: '/backlinks', label: 'Backlinks', icon: LinkIcon, group: 'Improve' },
  { to: '/local', label: 'Local SEO', icon: MapPin, group: 'Improve' },
  { to: '/recommendations', label: 'Recommendations', icon: Lightbulb, group: 'Improve' },
  { to: '/experiments', label: 'Experiments', icon: FlaskConical, group: 'Measure' },
  { to: '/change-log', label: 'Change Log', icon: History, group: 'Measure' },
  { to: '/migration', label: 'Migration Monitor', icon: GitCompareArrows, group: 'Measure' },
  { to: '/reports', label: 'Reports', icon: FileBarChart, group: 'Measure' },
  { to: '/alerts', label: 'Alerts', icon: Bell, badge: 'alerts', group: 'Measure' },
  { to: '/integrations', label: 'Integrations', icon: PlugZap, group: 'Workspace' },
  { to: '/ai-usage', label: 'AI Usage', icon: Bot, group: 'Workspace' },
  { to: '/organization', label: 'Organization', icon: Building2, group: 'Workspace' },
  { to: '/settings', label: 'Settings', icon: Settings, group: 'Workspace' },
  { to: '/admin', label: 'Platform admin', icon: ShieldCheck, group: 'Workspace', platformAdmin: true },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { counts, projects, projectId } = useProject();
  const { productName, isPlatformAdmin } = useAuth();
  const current = projects.find((p) => p.id === projectId);
  const brand = current?.organization_branding?.name || productName;
  const nav = NAV.filter((n) => !n.platformAdmin || isPlatformAdmin);
  const badge = (b?: NavItem['badge']) => {
    if (!b || !counts) return null;
    const n = b === 'approvals' ? (counts.pending_approvals ?? 0) + (counts.pending_content ?? 0) : counts.open_alerts ?? 0;
    if (!n) return null;
    return <span className={cx('ml-auto rounded-full px-1.5 py-px text-[11px] font-semibold tabular', b === 'approvals' ? 'bg-brand-500 text-white' : 'bg-gray-200 text-gray-700')}>{n}</span>;
  };
  return (
    <nav className="flex h-full flex-col" aria-label="Main">
      <div className="flex h-14 items-center gap-2.5 border-b border-gray-200 px-4">
        {current?.organization_branding?.logoUrl ? (
          <img src={current.organization_branding.logoUrl} alt="" className="h-7 w-7 rounded-md object-contain" />
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-500 text-sm font-bold text-white">{brand.charAt(0).toUpperCase()}</span>
        )}
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold text-gray-900">{brand}</div>
          <div className="truncate text-[11px] text-gray-500">{current?.organization_name ?? 'SEO workspace'}</div>
        </div>
      </div>
      <ul className="flex-1 space-y-px overflow-y-auto px-2 py-3">
        {nav.map((n, i) => (
          <li key={n.to}>
            {(i === 0 || nav[i - 1]!.group !== n.group) && <div className="px-2.5 pt-3 pb-1 text-[10px] font-semibold tracking-wider text-gray-400 uppercase first:pt-0">{n.group}</div>}
            <NavLink
              to={n.to}
              end={n.to === '/'}
              onClick={onNavigate}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                  isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <n.icon className={cx('h-4 w-4 shrink-0', isActive ? 'text-brand-600' : 'text-gray-400')} />
                  <span className="truncate">{n.label}</span>
                  {badge(n.badge)}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="border-t border-gray-200 px-4 py-3 text-[11px] leading-snug text-gray-400">
        <Activity className="mr-1 inline h-3 w-3" />
        AI-assisted, human-approved. Nothing is changed on the website without approval.
      </div>
    </nav>
  );
}
