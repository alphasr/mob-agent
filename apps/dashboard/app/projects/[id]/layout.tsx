import type { ReactNode } from 'react';
import { projectPage } from '../../../src/auth/request.ts';

export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: ReactNode;
}) {
  const { id } = await params;
  const { project } = await projectPage(id);
  return (
    <main>
      <nav className="crumbs">
        <a href="/">Projects</a> / <strong>{project.name}</strong>
      </nav>
      <nav className="tabs">
        <a href={`/projects/${id}`}>Overview</a>
        <a href={`/projects/${id}/turns`}>Turns</a>
        <a href={`/projects/${id}/settings`}>Settings</a>
      </nav>
      {children}
    </main>
  );
}
