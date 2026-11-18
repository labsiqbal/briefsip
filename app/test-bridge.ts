import { startRustServer } from './rust-test-server.ts';

export const startApp = startRustServer;

export const retainedToolNames = [
  'ask_user', 'call_mcp_tool', 'cancel_task', 'copy_skill_file', 'create_text_file', 'create_workspace_directory',
  'create_workspace_file', 'delegate_task', 'delete_site', 'edit_profile', 'generate_image', 'inspect_workspace_file',
  'interrupt_agent', 'list_agents', 'list_data_tables', 'list_mcp_tools', 'list_routines', 'list_sites', 'list_skills',
  'list_workspace', 'no_update', 'open_file_in_panel', 'publish_site', 'query_data', 'read_attachment', 'read_history',
  'read_message', 'read_provider_settings', 'read_routine', 'read_skill', 'read_skill_file', 'read_workspace_file',
  'remember_memory', 'report_failure', 'search_memory', 'select_memory', 'send_message', 'set_avatar', 'set_routine_flow',
  'task_status', 'transfer_task', 'wait_for_event', 'wait_task',
].sort();
