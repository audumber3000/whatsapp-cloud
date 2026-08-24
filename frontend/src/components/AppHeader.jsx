import { Menu, Moon, Sun, LogOut, User, Settings as SettingsIcon, ChevronDown } from 'lucide-react';
import Avatar from './ui/Avatar';
import Dropdown, { DropdownItem, DropdownDivider } from './ui/Dropdown';
import { WhatsAppGlyph } from './Brand';

/**
 * The application header.
 *
 * What it used to be: a hardcoded page title, a theme toggle, the literal
 * string "User", and a bare logout icon. The signed-in username was never even
 * stored — AuthView held it in local state and threw it away, keeping only the
 * token — so the app genuinely did not know who was using it.
 */
export default function AppHeader({
    title,
    me,                 // { user, org, whatsapp }
    isLinked,
    userPhone,
    effectiveTheme,
    onToggleTheme,
    onToggleSidebar,
    onNavigate,
    onLogout,
}) {
    const name = me?.user?.full_name || me?.user?.username || 'Account';
    const org = me?.org?.name;
    const role = me?.org?.role;
    const phone = userPhone || me?.whatsapp?.phone_number;

    return (
        <div className="header">
            <button className="icon-btn menu-toggle" onClick={onToggleSidebar} aria-label="Toggle navigation">
                <Menu size={20} />
            </button>

            <div className="header-title">{title}</div>

            <div className="header-actions">
                {/* Which number is actually connected — previously only visible
                    inside the dashboard body, never in the chrome. */}
                <span
                    className={`wa-pill ${isLinked ? 'on' : 'off'}`}
                    title={isLinked ? `Connected as +${phone}` : 'WhatsApp is not connected'}
                >
                    <i className="dot" />
                    <WhatsAppGlyph size={13} mono />
                    {isLinked && phone
                        ? <span className="num">+{phone}</span>
                        : <b>Not connected</b>}
                </span>

                <button
                    className="icon-btn"
                    onClick={onToggleTheme}
                    title={effectiveTheme === 'dark' ? 'Switch to light' : 'Switch to dark'}
                    aria-label="Toggle colour theme"
                >
                    {effectiveTheme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
                </button>

                <Dropdown
                    align="right"
                    width={230}
                    trigger={
                        <>
                            <Avatar name={name} src={me?.user?.avatar_url} size={32} />
                            <span className="header-id">
                                <b>{name}</b>
                                <span>{org}{role ? ` · ${role}` : ''}</span>
                            </span>
                            <ChevronDown size={15} style={{ color: 'var(--text-muted)' }} />
                        </>
                    }
                >
                    <div style={{ padding: '9px 10px 10px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{name}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {me?.user?.email || me?.user?.username}
                        </div>
                    </div>
                    <DropdownItem icon={<User size={16} />} onClick={() => onNavigate('profile')}>
                        Your profile
                    </DropdownItem>
                    <DropdownItem icon={<SettingsIcon size={16} />} onClick={() => onNavigate('settings')}>
                        Workspace settings
                    </DropdownItem>
                    <DropdownDivider />
                    <DropdownItem icon={<LogOut size={16} />} danger onClick={onLogout}>
                        Sign out
                    </DropdownItem>
                </Dropdown>
            </div>
        </div>
    );
}
