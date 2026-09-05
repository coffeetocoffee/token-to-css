export function registerConnector(connector: any): any;
export function getConnector(name: string): any;
export function listConnectors(): string[];
export function connectorPull(name: string, ctx?: any): Promise<any>;
export function connectorPush(name: string, tree: any, ctx?: any): Promise<any>;
export function toTransportTree(tokens: any): any;

export function registerFigmaConnector(opts: any): any;
export function tokensToFigmaVariables(tokens: any): any;
export function figmaVariablesToTokens(vars: any): any;

export function registerStorybookConnector(opts: any): any;
export function tokensToStorybookTheme(tokens: any): any;
export function storybookThemeToTokens(theme: any): any;

export function registerGithubPrConnector(opts: any): any;
export function tokensToGithubFiles(tokens: any): any;
export function githubFilesToTokens(files: any): any;

export function registerCmsConnector(opts: any): any;
export function tokensToCmsEntries(tokens: any): any;
export function cmsEntriesToTokens(entries: any): any;
