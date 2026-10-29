import React from 'react';
import { Atom, Binary, Blocks, BookOpen, Bot, BotMessageSquare, BrainCircuit, Braces, Bug, CircuitBoard, Cloud, Code2, Cpu, Database, FileCode2, FlaskConical, GitBranch, Globe2, Hammer, Image, Lightbulb, MessageSquare, Mic, Music2, Network, Package, Paintbrush, Rocket, Search, Server, ShieldCheck, Sparkles, Terminal, Video, WandSparkles, Workflow, Zap } from 'lucide-react';

export const nodeIconOptions = Object.freeze([
  ['chat', 'Chat', MessageSquare], ['bot', 'Agent', Bot], ['agent-chat', 'Agent chat', BotMessageSquare],
  ['brain', 'Reasoning', BrainCircuit], ['sparkles', 'AI', Sparkles], ['wand', 'Prompt magic', WandSparkles],
  ['code', 'Code', Code2], ['terminal', 'Terminal', Terminal], ['braces', 'JSON / data', Braces],
  ['file-code', 'Source file', FileCode2], ['git', 'Git workflow', GitBranch], ['workflow', 'Workflow', Workflow],
  ['cpu', 'Compute', Cpu], ['circuit', 'Circuit', CircuitBoard], ['binary', 'Binary', Binary], ['atom', 'Research', Atom],
  ['zap', 'Automation', Zap], ['idea', 'Ideation', Lightbulb], ['rocket', 'Launch', Rocket], ['bug', 'Debugging', Bug],
  ['experiment', 'Experiment', FlaskConical], ['docs', 'Documentation', BookOpen], ['database', 'Database', Database],
  ['web', 'Web', Globe2], ['search', 'Search', Search], ['blocks', 'Blocks', Blocks], ['package', 'Package', Package],
  ['build', 'Build', Hammer], ['design', 'Design', Paintbrush], ['image', 'Image', Image], ['music', 'Audio', Music2],
  ['video', 'Video', Video], ['voice', 'Voice', Mic], ['security', 'Security', ShieldCheck], ['cloud', 'Cloud', Cloud],
  ['server', 'Server', Server], ['network', 'Network', Network],
].map(([id, label, Component]) => Object.freeze({ id, label, Component })));

export function NodeIcon({ name, size = 16 }) {
  const { Component } = nodeIconOptions.find(option => option.id === name) ?? nodeIconOptions[0];
  return <Component size={size} strokeWidth={1.7} aria-hidden="true" />;
}

const paths = {
  chat: <path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" />,
  wiki: <><path d="M4 5a3 3 0 0 1 3-3h5v20H7a3 3 0 0 0-3 2z" /><path d="M20 5a3 3 0 0 0-3-3h-5v20h5a3 3 0 0 1 3 2z" /></>,
  source: <><path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14" /></>,
  handoff: <><path d="M4 7h13M14 4l3 3-3 3M20 17H7M10 14l-3 3 3 3" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5z" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z" /></>,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 8a7 7 0 0 1 11.8-1L20 12M4 12l2.1 5a7 7 0 0 0 11.8-1" /></>,
  layers: <path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5" />,
};

export function Icon({ name, size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
