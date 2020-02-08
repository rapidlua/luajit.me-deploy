const assert       = require('assert');
const bodyParser   = require('body-parser');
const crypto       = require('crypto');
const childProcess = require('child_process');
const express      = require('express');
const fs           = require('fs');
const https        = require('https');
const { spawn }    = require('child_process');

const dataDir      = process.env.DATA_DIR || '.';
const logDir       = process.env.LOG_DIR || '.';
const logURLPrefix = process.env.LOG_URL_PREFIX || 'https://deploy.luajit.me/logs';

// authenticate this service users
const agentSecret = process.env.AGENT_SECRET;
delete process.env.AGENT_SECRET;

// used to modify deployment statuses
const githubToken = process.env.GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN;

// full access
const digitalOceanToken = process.env.DIGITALOCEAN_TOKEN;
delete process.env.DIGITALOCEAN_TOKEN;

//
const sshKeyFingerprint = process.env.SSH_KEY_FINGERPRINT;
delete process.env.SSH_KEY_FINGERPRINT;

//
const sshPrivateKeyFile = process.env.SSH_PRIVATE_KEY_FILE;
delete process.env.SSH_PRIVATE_KEY_FILE;

const state = (function() {
  try {
    return JSON.parse(fs.readFileSync(dataDir + '/state.json'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    console.log('Error loading state:', e.message);
    process.exit(-1);
  }
}) ();

const [persistState, persistStateNow] = (() => {
  let persistPending = false;
  function persistStateNow() {
    persistPending = false;
    try {
      fs.writeFileSync(dataDir + '/.state.json', JSON.stringify(state, null, 2));
      fs.renameSync(dataDir + '/.state.json', dataDir + '/state.json');
    } catch (e) {
      console.log('Error saving state:', e.message);
      process.exit(-1);
    }
  }
  function persistState() {
    if (!persistPending) {
      persistPending = true;
      process.nextTick(() => persistPending && persistStateNow());
    }
  }
  return [persistState, persistStateNow];
}) ();

// addDeployment(id) -> bool; true iff this is a new deployment
const addDeployment = (function() {
  const deployments = new Set(state.deployments || []);
  state.deployments = { toJSON: () => Array.from(deployments) };
  return function(id) {
    if (deployments.has(id)) return false;
    deployments.add(id);
    persistState();
    return true;
  }
}) ();

// postDeploymentStatus(id, ghStatus)
const postDeploymentStatus = (function() {
  const inflight = new Map(), pending = new Map();
  function deliver(id, ghStatus, cb) {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/rapidlua/luajit.me/deployments/${id}/statuses`,
      method: 'POST',
      headers: {
        'User-Agent': 'deploy-daemon',
        'Authorization': 'token ' + githubToken,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.flash-preview+json, application/vnd.github.ant-man-preview+json'
      }
    }, (res) => cb(res.statusCode === 201 ? null : new Error(res.statusMessage)));
    req.on('error', cb);
    req.end(JSON.stringify(ghStatus));
  }
  function postStatus(id, ghStatus) {
    if (inflight.has(id)) return void pending.set(id, ghStatus);
    inflight.set(id, ghStatus);
    deliver(id, ghStatus, (err) => {
      if (err) console.log(`Failed to update status: #${id} -> ${ghStatus.state}:`, err.message);
      inflight.delete(id);
      if (!(ghStatus = pending.get(id))) return void persistState();
      pending.delete(id);
      postStatus(id, ghStatus);
    });
  }
  for (const [key, value] of Object.entries(state.inDelivery || {})) {
    postStatus(+key, value);
  }
  function fromEntries(map) {
    const res = {};
    for (let [k, v] of map.entries()) res[k] = v;
    return res;
  }
  state.inDelivery = { toJSON: () => Object.assign(fromEntries(inflight), fromEntries(pending)) };
  return (id, ghStatus) => (postStatus(id, ghStatus), void persistState());
}) ();

// createDeploymentEnv(...) -> { deploy: ..., deactivate: ..., rescale: ..., sha: ... }
function createDeploymentEnv(name, handler) {
  const PENDING = 'pending', INPROGRESS = 'in-progress', FAILED = 'failed', DONE = undefined;
  let id, sha, payload, s = DONE, next = null, rescalePending = false;
  function deploy(options) {
    persistState();
    if (next && next.id !== undefined)
      postDeploymentStatus(next.id, { state: 'inactive' });
    next = { id: options.id, sha: options.sha, payload: options.payload };
    if (options.id !== undefined)
      postDeploymentStatus(options.id, { state: 'queued' });
    doDeploy();
  }
  function onComplete(status) {
    persistState();
    assert(s === INPROGRESS);
    s = status === undefined ? DONE : FAILED;
    doDeploy();
  }
  function doDeploy() {
    if (s === INPROGRESS || !(next || rescalePending)) return;
    persistState();
    rescalePending = false;
    if (next) {
      if (id !== undefined && s !== FAILED)
        postDeploymentStatus(id, { state: 'inactive' });
      ({id, sha, payload} = next);
      next = null;
      process.nextTick(handler, name, id ? 'deploy' : 'deactivate', {id, sha, payload}, onComplete);
    } else {
      process.nextTick(handler, name, 'rescale', {id, sha, payload}, onComplete);
    }
    s = INPROGRESS;
  }
  if (state[name]) {
    if ([DONE, FAILED].indexOf(state[name].s) === -1) deploy(state[name]);
    else ({id, sha, payload, s} = state[name]);
  }
  state[name] = { toJSON: () => Object.assign({ s: PENDING }, next || {id, sha, payload, s}) };
  // persisting a single deployment state, hence current state is lost
  // when next is present; to compensate, persistent state will include an
  // extra inDelivery message; if delivered, it switches the lost deployment's to inactive
  const gsInDelivery = state.inDelivery;
  state.inDelivery = { toJSON: function() {
    const inDelivery = gsInDelivery.toJSON();
    if (id !== undefined && next && s !== FAILED)
      inDelivery[id] = { state: 'inactive' };
    return inDelivery;
  }};
  const o = {
    deploy: function(options) {
      assert(options.id !== undefined);
      addDeployment(options.id) && deploy(options);
    },
    rescale: function() {
      rescalePending = id !== undefined && s !== FAILED;
      doDeploy();
    },
    deactivate: function() { id !== undefined && deploy({}); }
  };
  return Object.defineProperty(o, 'sha', { get: () => next ? next.sha : sha });
}

async function deploy(env, action, options, onComplete) {

  const srcDir            = `${dataDir}/${env}/src`;
  const terraformStateDir = `${dataDir}/${env}/tfstate`;
  const terraformSrcDir   = `${dataDir}/${env}/src/deployments/${env}`;
  let logFD;

  function logWrite(data) {
    if (logFD !== undefined) fs.writeFileSync(logFD, data + '');
    else console.log(data);
  }

  function gitFetch() {
    return new Promise((resolve, reject) => {
      logWrite('$ git fetch\n');
      const git = spawn('git', ['fetch'], {
        cwd: srcDir, stdio: ['ignore', logFD, logFD]
      });
      git.on('error', reject);
      git.on('close', (code) => {
        code === 0 ? resolve() : reject(new Error('git fetch'));
      });
    });
  }
  function gitCheckout() {
    return new Promise((resolve, reject) => {
      logWrite(`$ git checkout ${options.sha}\n`);
      const git = spawn('git', ['-c', 'advice.detachedHead=false', 'checkout', '-f', options.sha], {
        cwd: srcDir, stdio: ['ignore', logFD, logFD]
      });
      git.on('error', reject);
      git.on('close', (code) => {
        code === 0 ? resolve() : reject(new Error('git checkout'));
      });
    });
  }
  function isSHA1AncestorOfSHA2(sha1, sha2) {
    return new Promise((resolve, reject) => {
      if (!sha2 || !sha2) resolve(false);
      const git = spawn('git', ['merge-base', '--is-ancestor', sha1, sha2], {
        cwd: srcDir, stdio: 'ignore'
      });
      git.on('error', reject);
      git.on('close', (code) => resolve(code === 0));
    });
  }
  function getTerraformEnv() {
    return {
      TF_VAR_digitalocean_token: digitalOceanToken,
      TF_VAR_ssh_key_fingerprint: sshKeyFingerprint,
      TF_VAR_ssh_private_key_file: sshPrivateKeyFile,
      TF_VAR_app_version: options.payload ? options.payload.version : ""
    };
  }
  function terraformInit() {
    const terraformInitArgs = [ 'init', '-no-color', terraformSrcDir ];
    return new Promise((resolve, reject) => {
      logWrite('$ terraform init\n');
      const terraform = spawn('terraform', terraformInitArgs, {
        cwd: terraformStateDir, stdio: ['ignore', logFD, logFD]
      });
      terraform.on('error', reject);
      terraform.on('close', (code) => {
        code === 0 ? resolve() : reject(new Error('terraform init'));
      });
    });
  }
  function terraformApply() {
    const terraformApplyArgs = [
      'apply', '-input=false', '-no-color', '-auto-approve',
      '-parallelism=100', terraformSrcDir
    ];
    return new Promise((resolve, reject) => {
      logWrite('$ terraform apply\n');
      const terraform = spawn('terraform', terraformApplyArgs, {
        cwd: terraformStateDir, stdio: ['ignore', logFD, logFD],
        env: Object.assign({}, process.env, getTerraformEnv())
      });
      terraform.on('error', reject);
      terraform.on('close', (code) => {
        code === 0 ? resolve() : reject(new Error('terraform apply'));
      });
    });
  }
  function terraformOutput() {
    return new Promise((resolve, reject) => {
      const terraform = spawn('terraform', ['output', '-json'], {
        cwd: terraformStateDir, stdio: ['ignore', 'pipe', logFD]
      });
      const out = [];
      terraform.stdout.on('data', buf => out.push(buf));
      terraform.stdout.on('close', function() {
        try {
          resolve(JSON.parse(Buffer.concat(out).toString()));
        } catch (e) { reject(e); }
      });
    });
  }
  function terraformDestroy() {
    const terraformDestroyArgs = [
      'destroy', '-input=false', '-no-color', '-auto-approve', terraformSrcDir
    ];
    return new Promise((resolve, reject) => {
      logWrite('$ terraform destroy\n');
      const terraform = spawn('terraform', terraformDestroyArgs, {
        cwd: terraformStateDir, stdio: ['ignore', logFD, logFD],
        env: Object.assign({}, process.env, getTerraformEnv())
      });
      terraform.on('error', reject);
      terraform.on('close', (code) => {
        code === 0 ? resolve() : reject(new Error('terraform destroy'));
      });
    });
  }

  function reconfigure(terraformOutput) {
    const to = terraformOutput;
    switch (env) {
    case 'staging':
      state.stagingHost = to.staging_ip ? to.staging_ip.value[0] : undefined;
      break;
    }
    persistState();
  }

  let logURL;
  try {
    // create log file
    while (true) {
      const name = Math.random().toString(36).substr(2, 8);
      if (name.length !== 8) continue;
      try {
        logFD = fs.openSync(
          `${logDir}/${name}.log`,
          fs.constants.O_RDWR | fs.constants.O_CREAT |
          fs.constants.O_EXCL | fs.constants.O_APPEND
        );
        logURL = `${logURLPrefix}/${name}.log`;
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }

    if (options.id)
      postDeploymentStatus(options.id, { state: 'in_progress', log_url: logURL });

    switch (action) {
    case 'deploy':
      await gitFetch();
      await gitCheckout();
      if (env === 'staging' && await isSHA1AncestorOfSHA2(staging.sha, production.sha)) {
        staging.deactivate();
        logWrite('[deployment superceeded by a newer production deployment]\n');
        break;
      }
      await terraformInit();
      await terraformApply();
      reconfigure(await terraformOutput());
      if (env === 'production' && await isSHA1AncestorOfSHA2(staging.sha, options.sha))
        staging.deactivate();
      break;
    case 'deactivate':
      await terraformDestroy();
      reconfigure({});
      break;
    case 'rescale':
      await terraformApply();
      reconfigure(await terraformOutput());
      break;
    }

    if (options.id)
      postDeploymentStatus(options.id, { state: 'success', log_url: logURL });

    logWrite('[deployment succeeded]\n');

    onComplete();

  } catch (e) {
    logWrite(`[deployment failed: ${e.message}]\n`);

    if (options.id)
      postDeploymentStatus(options.id, { state: 'failure', log_url: logURL });

    onComplete('failed');
  }

  if (logFD !== undefined) fs.closeSync(logFD);
}

const production = createDeploymentEnv('production', deploy);
const staging = createDeploymentEnv('staging', deploy);

const app       = express();
const rawParser = bodyParser.raw({ type: '*/*' });
const proxy     = require('express-http-proxy');

app.post('/deploy/new', rawParser, function (req, res) {
  const signature = req.header('X-Hub-Signature');
  if (signature && req.body instanceof Buffer
    && secureEqual(signature, computeSignature(req.body))
  ) {
    try {
      const d = JSON.parse(req.body.toString()).deployment;
      if (d) {
        (d.environment === 'production' ? production : staging).deploy(d);
        persistStateNow();
      }
      res.status(200).send();
    } catch (e) {
      console.error(e);
      res.status(500).send(e.message);
    }
  } else {
    res.status(500).send('Signature mismatch');
  }
});

function computeSignature(data) {
  return 'sha1=' + crypto.createHmac('sha1', agentSecret).update(data).digest('hex');
}

function secureEqual(a, b) {
  a = new Buffer(a);
  b = new Buffer(b);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use('/deploy', (req, res) => res.redirect('https://github.com/rapidlua/luajit.me/deployments'));

app.use('/staging', proxy(() => 'http://' + state.stagingHost, {
  memoizeHost: false,
  filter: () => state.stagingHost !== undefined
}));

app.listen(8000, 'localhost', function () { console.log('agent ready'); });
