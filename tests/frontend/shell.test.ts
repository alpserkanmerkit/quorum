import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TopBar from '../../components/TopBar';

// Desk v2 shell (F009): four module tabs across the top, the current one marked, no side menu.
function renderShellAt(path: string): string {
    return renderToStaticMarkup(
        createElement(MemoryRouter, { initialEntries: [path] }, createElement(TopBar)),
    );
}

describe('TopBar shell', () => {
    it('shows the four modules as top tabs in order', () => {
        const html = renderShellAt('/dashboard');
        const labels = [...html.matchAll(/<a [^>]*class="q-tab[^"]*"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
        expect(labels).toEqual(['Intelligence Feed', 'Portfolio &amp; Risk', 'Strategy Boardroom', 'Compliance']);
    });

    it('marks only the current module as active', () => {
        const html = renderShellAt('/portfolio');
        const active = [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
        expect(active).toEqual(['Portfolio &amp; Risk']);
    });

    it('has no side menu', () => {
        const html = renderShellAt('/compliance');
        expect(html).not.toContain('<aside');
        expect(html).not.toContain('q-sidebar');
    });
});
