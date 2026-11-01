import React, { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Users, UserPlus, Trash2 } from 'lucide-react';
import { UserRole } from '../types';
import { usePortfolioStore } from '../stores/portfolioStore';
import { useAuthStore } from '../stores/authStore';
import apiClient, { getApiErrorMessage } from '../utils/apiClient';
import { BRAND } from '../shared/brand';

// Desk v2 shell: module tabs across the top (no side menu). Portfolio and team selectors and
// team governance sit on the right of the bar; feed filters live on the feed page itself.
const NAV_ITEMS = [
  { path: '/dashboard', label: 'Intelligence Feed' },
  { path: '/portfolio', label: 'Portfolio & Risk' },
  { path: '/war-room', label: 'Strategy Boardroom' },
  { path: '/compliance', label: 'Compliance' },
];

const TEAM_ROLES: UserRole[] = ['ADMIN', 'COMPLIANCE_OFFICER', 'FUND_MANAGER', 'ANALYST'];

interface TeamMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

const TopBar: React.FC = () => {
  const { portfolios, activePortfolioId, setActivePortfolio } = usePortfolioStore();
  const { token, user, setAuth } = useAuthStore();
  const [teams, setTeams] = useState<Array<{ teamId: string; teamName: string; role: string }>>([]);
  const [isTeamAdminOpen, setIsTeamAdminOpen] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<UserRole>('ANALYST');
  const [teamMessage, setTeamMessage] = useState<string | null>(null);
  const [isTeamSaving, setIsTeamSaving] = useState(false);
  const [isTeamLoading, setIsTeamLoading] = useState(false);
  const activeTeamId = user?.teamContext?.teamId ?? null;
  const activeTeamRole = user?.teamContext?.role ?? null;
  const canManageTeam = Boolean(token && activeTeamId && activeTeamRole === 'ADMIN');
  const visibleTeams = token ? teams : [];
  const visibleTeamMembers = canManageTeam && activeTeamId ? teamMembers : [];

  const loadTeamMembers = useCallback(async (teamId: string) => {
    setIsTeamLoading(true);
    try {
      const response = await apiClient.get(`/api/teams/${teamId}/members`);
      setTeamMembers(response.data.members ?? []);
      setTeamMessage(null);
    } catch (error) {
      setTeamMembers([]);
      setTeamMessage(getApiErrorMessage(error, 'Failed to load team members.'));
    } finally {
      setIsTeamLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;
    void apiClient.get('/api/teams')
      .then((response) => {
        if (!cancelled) setTeams(response.data.teams ?? []);
      })
      .catch(() => {
        if (!cancelled) setTeams([]);
      });

    return () => {
      cancelled = true;
    };
  }, [token, activeTeamId]);

  useEffect(() => {
    if (!canManageTeam || !activeTeamId) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void loadTeamMembers(activeTeamId);
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [canManageTeam, activeTeamId, loadTeamMembers]);

  const switchTeam = async (teamId: string) => {
    if (!teamId || teamId === activeTeamId) return;
    const response = await apiClient.post(`/api/teams/${teamId}/switch`, {});
    if (response.data.token && response.data.user) {
      setAuth(response.data.token, response.data.user);
    }
  };

  const addTeamMember = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeTeamId || !newMemberEmail.trim()) return;
    setIsTeamSaving(true);
    try {
      await apiClient.post(`/api/teams/${activeTeamId}/members`, {
        email: newMemberEmail.trim(),
        role: newMemberRole,
      });
      setNewMemberEmail('');
      setTeamMessage('Team member saved.');
      await loadTeamMembers(activeTeamId);
    } catch (error) {
      setTeamMessage(getApiErrorMessage(error, 'Failed to save team member.'));
    } finally {
      setIsTeamSaving(false);
    }
  };

  const updateTeamMemberRole = async (member: TeamMember, role: UserRole) => {
    if (!activeTeamId || member.role === role) return;
    setIsTeamSaving(true);
    try {
      await apiClient.patch(`/api/teams/${activeTeamId}/members/${member.userId}`, { role });
      setTeamMessage('Team role updated.');
      await loadTeamMembers(activeTeamId);
    } catch (error) {
      setTeamMessage(getApiErrorMessage(error, 'Failed to update team role.'));
    } finally {
      setIsTeamSaving(false);
    }
  };

  const removeTeamMember = async (member: TeamMember) => {
    if (!activeTeamId || member.userId === user?.id) return;
    setIsTeamSaving(true);
    try {
      await apiClient.delete(`/api/teams/${activeTeamId}/members/${member.userId}`);
      setTeamMessage('Team member removed.');
      await loadTeamMembers(activeTeamId);
    } catch (error) {
      setTeamMessage(getApiErrorMessage(error, 'Failed to remove team member.'));
    } finally {
      setIsTeamSaving(false);
    }
  };

  return (
    <header className="q-topbar">
      <div className="q-topbar__inner">
        <div className="q-brand">
          <span className="q-brand__name">{BRAND.name}</span>
          <span className="q-brand__tagline">{BRAND.tagline}</span>
        </div>

        <nav className="q-tabs" aria-label="Modules">
          {NAV_ITEMS.map(({ path, label }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) => `q-tab${isActive ? ' q-tab--active' : ''}`}
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="q-topbar__controls">
          <label className="q-topbar__field">
            <span className="q-visually-hidden">Active portfolio</span>
            <select
              value={activePortfolioId}
              onChange={(e) => setActivePortfolio(e.target.value)}
              className="q-portfolio-select"
            >
              {portfolios.map((portfolio) => (
                <option key={portfolio.id} value={portfolio.id}>
                  {portfolio.name}
                </option>
              ))}
            </select>
          </label>

          {user && (
            <label className="q-topbar__field">
              <span className="q-visually-hidden">Active team</span>
              <select
                value={user.teamContext?.teamId ?? ''}
                onChange={(event) => void switchTeam(event.target.value)}
                className="q-portfolio-select"
              >
                {(visibleTeams.length > 0 ? visibleTeams : user.teamContext ? [user.teamContext] : []).map((team) => (
                  <option key={team.teamId} value={team.teamId}>
                    {team.teamName} ({team.role})
                  </option>
                ))}
              </select>
            </label>
          )}

          {canManageTeam && activeTeamId && (
            <div className="q-team-menu">
              <button
                type="button"
                className="q-btn q-btn--ghost q-btn--sm q-team-menu__toggle"
                aria-expanded={isTeamAdminOpen}
                onClick={() => setIsTeamAdminOpen((open) => !open)}
              >
                <Users size={14} /> Team Governance
                <span className="q-team-menu__count">{visibleTeamMembers.length}</span>
              </button>

              {isTeamAdminOpen && (
                <div className="q-team-admin">
                  <form onSubmit={addTeamMember} className="q-team-form">
                    <input
                      className="q-input q-input--sm"
                      value={newMemberEmail}
                      onChange={(event) => setNewMemberEmail(event.target.value)}
                      placeholder="member@example.com"
                      type="email"
                    />
                    <select
                      className="q-portfolio-select"
                      value={newMemberRole}
                      onChange={(event) => setNewMemberRole(event.target.value as UserRole)}
                    >
                      {TEAM_ROLES.map((role) => (
                        <option key={role} value={role}>{role}</option>
                      ))}
                    </select>
                    <button type="submit" className="q-btn q-btn--ghost q-btn--sm" disabled={isTeamSaving || !newMemberEmail.trim()}>
                      <UserPlus size={12} /> Add Existing User
                    </button>
                  </form>

                  {teamMessage && (
                    <div className={`q-team-message ${teamMessage.toLowerCase().includes('failed') ? 'q-team-message--error' : ''}`}>
                      {teamMessage}
                    </div>
                  )}

                  <div className="q-team-list">
                    {isTeamLoading ? (
                      <span className="q-team-loading">Loading team members...</span>
                    ) : visibleTeamMembers.map((member) => (
                      <div key={member.id} className="q-team-row">
                        <span className="q-team-email">
                          {member.email}
                        </span>
                        <div className="q-team-actions">
                          <select
                            className="q-portfolio-select"
                            value={member.role}
                            onChange={(event) => void updateTeamMemberRole(member, event.target.value as UserRole)}
                            disabled={isTeamSaving}
                          >
                            {TEAM_ROLES.map((role) => (
                              <option key={role} value={role}>{role}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="q-btn q-btn--ghost q-btn--sm q-btn--icon"
                            onClick={() => void removeTeamMember(member)}
                            disabled={isTeamSaving || member.userId === user?.id}
                            title={member.userId === user?.id ? 'Cannot remove the active session user here' : 'Remove member'}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default TopBar;
