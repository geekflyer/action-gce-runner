import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import { getVMName } from "./utils";
import { promisify } from "util";

const delay = promisify(setTimeout);

const vmName = getVMName();

// if $actions_preinstalled ; then
// echo "✅ Startup script won't install GitHub Actions (pre-installed)"
// startup_script="#!/bin/bash
// cd /actions-runner
// $startup_script"
// else
// echo "✅ Startup script will install GitHub Actions"
// startup_script="#!/bin/bash
// mkdir /actions-runner
// cd /actions-runner
// curl -o actions-runner-linux-x64-${runner_ver}.tar.gz -L https://github.com/actions/runner/releases/download/v${runner_ver}/actions-runner-linux-x64-${runner_ver}.tar.gz
// tar xzf ./actions-runner-linux-x64-${runner_ver}.tar.gz
// ./bin/installdependencies.sh && \\
// $startup_script"
// fi

const SECOND = 1000;

async function run(): Promise<void> {
  try {
    const command = core.getInput("command");

    switch (command) {
      case "create":
        return createVM();
      case "delete":
        return deleteVM();
      default:
        core.setFailed(`Invalid command parameter: ${command}`);
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

async function authGcloud() {
  core.info(`Authenticating gcloud ...`);

  const gcpProject = core.getInput("gcp_project");
  const gcpServiceAccountKey = core.getInput("gcp_service_account_key");

  await exec.exec(
    `gcloud --project ${gcpProject} --quiet auth activate-service-account --key-file -`,
    undefined,
    { input: Buffer.from(gcpServiceAccountKey, "utf-8") }
  );

  core.info(`Successfully authenticated gcloud ...`);
}

// need to access default scope to compute-rw so that the VM can tag itself.
const SCOPES_TO_ASSIGN = "default,compute-rw";

async function createVM() {
  const ghRunnerVersion = core.getInput("gh_runner_version");
  const gcpZone = core.getInput("gcp_zone");
  const gcpImageProject = core.getInput("gcp_image_project");
  const gcpMachineType = core.getInput("gcp_machine_type");
  const gcpImageFamily = core.getInput("gcp_image_family");
  const githubApiToken = core.getInput("gh_api_token_to_issue_runner_tokens");

  const ghClient = github.getOctokit(githubApiToken);

  const freshRunnerToken = (
    await ghClient.rest.actions.createRegistrationTokenForRepo({
      owner: process.env.GITHUB_REPOSITORY_OWNER!,
      repo: process.env.GITHUB_REPOSITORY!.split("/")[1],
    })
  ).data.token;

  core.setSecret(freshRunnerToken);

  core.info("✅ Successfully got the GitHub Runner registration token");

  await authGcloud();

  core.info(`Creating GCP GCE VM ...`);

  const metadataStartupScript = `#!/bin/bash
set -e
mkdir /actions-runner
cd /actions-runner
echo download_actions_runner
curl --silent -o actions-runner-linux-x64-${ghRunnerVersion}.tar.gz -L https://github.com/actions/runner/releases/download/v${ghRunnerVersion}/actions-runner-linux-x64-${ghRunnerVersion}.tar.gz
tar xzf ./actions-runner-linux-x64-${ghRunnerVersion}.tar.gz
echo configurung_actions_runner
RUNNER_ALLOW_RUNASROOT=1 ./config.sh --url https://github.com/${process.env.GITHUB_REPOSITORY} --token ${freshRunnerToken} --labels ${vmName} --disableupdate --ephemeral --unattended
echo adding_gh_ready_label
gcloud compute instances add-labels ${vmName} --zone=${gcpZone} --labels=gh_ready=1
echo starting_github_actions_runner
RUNNER_ALLOW_RUNASROOT=1 ./run.sh
`;

  //   ./bin/installdependencies.sh
  //   gcloud compute instances add-labels ${vmName} --zone=${gcpZone} --labels=gh_ready=0
  //   RUNNER_ALLOW_RUNASROOT=1 ./config.sh --url https://github.com/${githubRepo} --token ${RUNNER_TOKEN} --labels ${VM_ID} --unattended ${ephemeral_flag} --disableupdate && \\
  //   ./svc.sh install && \\
  // ./svc.sh start && \\
  // gcloud compute instances add-labels ${VM_ID} --zone=${machine_zone} --labels=gh_ready=1
  // # 3 days represents the max workflow runtime. This will shutdown the instance if everything else fails.
  // echo \"gcloud --quiet compute instances delete ${VM_ID} --zone=${machine_zone}\" | at now + 3 days
  // `;

  await exec.exec(`gcloud compute instances create ${vmName} \
  --quiet \
  --zone=${gcpZone} \
  --scopes=${SCOPES_TO_ASSIGN} \
  --image-project=${gcpImageProject} \
  --image-family=${gcpImageFamily} \
  --metadata=startup-script="${metadataStartupScript}" \
  --machine-type=${gcpMachineType} \
  --labels=gh_ready=0`);

  core.info(`Successfully created GCE Instance with name: ${vmName}`);
  core.info(
    `Waiting for instance to be ready and github runner agent running ...`
  );

  const start = Date.now();

  let machineReady = false;

  while (Date.now() - start < 120 * SECOND) {
    let cmdOutput = "";
    await exec.exec(
      `gcloud compute instances describe ${vmName} --zone=${gcpZone} --format="json(labels)"`,
      [],
      {
        silent: true,
        listeners: {
          stdout: (data: Buffer) => {
            cmdOutput += data.toString();
          },
        },
      }
    );

    const labelResponse: { labels: Record<string, string> } =
      JSON.parse(cmdOutput);
    if (labelResponse.labels.gh_ready === "1") {
      machineReady = true;
      break;
    }
    core.info(`${vmName} not ready yet, waiting 1 sec ...`);
    await delay(SECOND);
  }

  if (!machineReady) {
    core.setFailed(
      "🤯 - VM will still not ready / registered with GitHub after 2 minutes..."
    );
  } else {
    core.info(`✅ ${vmName} is ready and accepting work! 💪`);
  }

  core.debug(new Date().toTimeString());

  core.setOutput("runner_label", vmName);
}

async function deleteVM() {
  await authGcloud();
  core.info("Stopping GCE VM ...");

  // NOTE: it would be nice to gracefully shut down the runner, but we actually don't need
  //       to do that. VM shutdown will disconnect the runner, and GH will unregister it
  //       in 30 days
  // TODO: RUNNER_ALLOW_RUNASROOT=1 /actions-runner/config.sh remove --token $TOKEN

  const gcpZone = core.getInput("gcp_zone");

  exec.exec(
    `gcloud --quiet compute instances delete ${getVMName()} --zone=${gcpZone}`
  );
}

run();
