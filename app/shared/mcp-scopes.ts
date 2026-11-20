// Shared public scope metadata. Never derive grants from this catalog.
export const mcpScopeCatalog = [
  { id:'agents:read', group:'Read', label:'List agents', hint:'Read names, descriptions, models, and availability.' },
  { id:'agents:profile', group:'Read', label:'Read agent profiles', hint:'Read full profiles, instructions, runtimes, and status.' },
  { id:'history:read', group:'Read', label:'Read message history', hint:'Read only conversations started with this token.' },
  { id:'conversations:read', group:'Read', label:'Read conversations', hint:'List conversations and read their messages, including archived chats.' },
  { id:'projects:read', group:'Read', label:'Read projects', hint:'Read project members, folders, and sections.' },
  { id:'routines:read', group:'Read', label:'Read routines', hint:'Read routine settings, schedules, and run history.' },
  { id:'workflows:read', group:'Read', label:'Read workflows', hint:'Read workflow definitions and run status.' },
  { id:'machines:read', group:'Read', label:'Read machines and updates', hint:'Read paired machines, versions, and local update status.' },
  { id:'settings:read', group:'Read', label:'Read integration settings', hint:'List connected apps, MCP grants, and environment variable names. Secret values stay hidden.' },
  { id:'computer:read', group:'Read', label:'Read computer status', hint:'Read agent computer availability and control status.' },
  { id:'usage:read', group:'Read', label:'Read usage', hint:'Read provider usage records.' },
  { id:'skills:read', group:'Read', label:'Read skills', hint:'List available skills and versions.' },
  { id:'agents:write', group:'Write', label:'Manage agent profiles', hint:'Create and edit agents. Hiding an agent requires confirmation.' },
  { id:'conversations:write', group:'Write', label:'Manage conversations', hint:'Create, rename, archive, restore, and delete idle side conversations. Deletion requires confirmation.' },
  { id:'projects:write', group:'Write', label:'Manage projects', hint:'Create projects, edit sections and members, and send section messages. Folder write access requires confirmation.' },
  { id:'routines:write', group:'Write', label:'Manage routines', hint:'Create, edit, pause, resume, and run routines. Deletion requires confirmation.' },
  { id:'agents:message', group:'Run', label:'Send messages', hint:'Start local agent work and read replies to its own messages.' },
  { id:'workflows:run', group:'Run', label:'Run workflows', hint:'Start runs of existing workflows.' },
  { id:'computer:run', group:'Run', label:'Open agent computers', hint:'Start computers already enabled by the Owner. Viewer access stays in Minarbot.' },
  { id:'orchestration', group:'Run', label:'Use delegation and app tools', hint:'Delegate tasks, read or cancel them, and use granted tools in a running conversation.' },
  { id:'machine:update', group:'Run', label:'Allow paired machine updates', hint:'Requires a paired machine and update consent on both devices. Creating this token alone cannot apply updates.' },
] as const;
export type McpScope = typeof mcpScopeCatalog[number]['id'];
export const mcpScopes: readonly McpScope[] = mcpScopeCatalog.map(scope => scope.id);
