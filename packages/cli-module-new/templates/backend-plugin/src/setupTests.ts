jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(),
}));

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({})),
}));

export {};
