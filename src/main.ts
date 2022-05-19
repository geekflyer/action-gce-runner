import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as http from "@actions/http-client";
import { getVMName } from "./utils";

const vmName = getVMName();

async function run(): Promise<void> {
  try {
    core.info(`Authenticating gcloud ...`);

    const gcpProject = core.getInput("gcp_project");
    const serviceAccountKey = core.getInput("service_account_key");
    const gcpZone = core.getInput("gcp_zone");
    const gcpImageFamily = core.getInput("gcp_image_family");

    await exec.exec(
      `gcloud --project ${gcpProject} --quiet auth activate-service-account --key-file -`,
      undefined,
      { input: Buffer.from(serviceAccountKey, "utf-8") }
    );

    core.info(`Successfully authenticated gcloud ...`);
    core.info(`Creating GCP GCE VM ...`);

    await exec.exec(`cloud compute instances create ${vmName} \
    --zone=${gcpZone} \
    --image_familiy=${gcpImageFamily}
    --machine-type=e2-standard-2 \
    --labels=gh_ready=0`);

    core.info(`Successfully create GCE Instance with name: ${vmName}`);

    core.debug(new Date().toTimeString());

    core.setOutput("runner_label", vmName);
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

async function startVM() {
  core.info(`Authenticating gcloud ...`);

  const gcpProject = core.getInput("gcp_project");
  const serviceAccountKey = core.getInput("service_account_key");
  const gcpZone = core.getInput("gcp_zone");

  await exec.exec(
    `gcloud --project ${gcpProject} --quiet auth activate-service-account --key-file -`,
    undefined,
    { input: Buffer.from(serviceAccountKey, "utf-8") }
  );

  core.info(`Successfully authenticated gcloud ...`);
  core.info(`Creating GCP GCE VM ...`);

  const vmName = getVMName();

  await exec.exec(`cloud compute instances create ${vmName} \
  --zone=${gcpZone} \
  --machine-type=e2-standard-2 \
  --labels=gh_ready=0`);

  core.info(`Successfully create GCE Instance with name: ${vmName}`);

  core.debug(new Date().toTimeString());

  core.setOutput("runner_label", vmName);
}

async function stopVM() {
  core.info("Stopping GCE VM ...");
  // NOTE: it would be nice to gracefully shut down the runner, but we actually don't need
  //       to do that. VM shutdown will disconnect the runner, and GH will unregister it
  //       in 30 days
  // TODO: RUNNER_ALLOW_RUNASROOT=1 /actions-runner/config.sh remove --token $TOKEN

  const client = new http.HttpClient("action-gce-runner", [], {
    headers: {
      "Metadata-Flavor": "Google",
    },
  });

  const [name, zone] = await Promise.all(
    [
      "http://metadata.google.internal/computeMetadata/v1/instance/name",
      "http://metadata.google.internal/computeMetadata/v1/instance/zone",
    ].map(async (url) => (await client.get(url)).readBody())
  );

  core.info(`✅ Self deleting ${vmName} now ...}`);

  exec.exec(`gcloud --quiet compute instances delete ${name} --zone=${zone}`);
}

run();
