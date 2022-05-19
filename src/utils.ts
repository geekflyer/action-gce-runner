export function getVMName() {
  return `gh-runner-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
}

