// Init module — registers cmux-swarm with AI coding tools.

export type InitOptions = {
  projectRoot?: string;
};

export type InitResult = {
  mode: 'global' | 'project';
  updatedFiles: string[];
  projectRoot?: string;
};

export function initGlobal(): InitResult {
  return { mode: 'global', updatedFiles: [] };
}

export function initProject(_options: InitOptions = {}): InitResult {
  return { mode: 'project', updatedFiles: [] };
}
