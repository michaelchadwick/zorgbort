'use strict';

if (!process.env.SSH_KEY_PASSPHRASE) {
  throw new Error('Error: Specify SSH_KEY_PASSPHRASE in environment');
}

const SSH_KEY_PASSPHRASE = process.env.SSH_KEY_PASSPHRASE;

const uniqueid = require('uniqueid');
const getUniqueId = uniqueid(process.pid);
const fs = require('mz/fs');
const Git = require('nodegit');
const Github = require('../lib/github');
const Handlebars = require('handlebars');
const cheeseName = require('cheese-name');
const rmdir = require('rimraf');
const mkdirp = require('mkdirp');
const moment = require('moment');
const uniqueReleaseName = require('../lib/uniqueReleaseName');
const generateReleaseNotes = require('../lib/generateReleaseNotes');
const incrementPackageVersion = require('../lib/incrementPackageVersion');

const cloneRepository = async (owner, repo, target) => {
  const url = `git@github.com:${owner}/${repo}`;
  const appRoot = require('app-root-path');
  const sshPublicKeyPath = appRoot + '/ssh-keys/zorgbort.pub';
  const sshPrivateKeyPath = appRoot + '/ssh-keys/zorgbort';
  const opts = {
    fetchOpts: {
      callbacks: {
        credentials: function(url, userName) {
          return Git.Cred.sshKeyNew(
            userName,
            sshPublicKeyPath,
            sshPrivateKeyPath,
            SSH_KEY_PASSPHRASE
          );
        }
      }
    }
  };

  return await Git.Clone(url, target, opts);
};

const commitAndTag = async (dir, name, releaseName) => {
  const message = `${name} ${releaseName}`;

  // From the examples at https://github.com/nodegit/nodegit/blob/master/examples/
  const repository = await Git.Repository.open(dir);
  const index = await repository.refreshIndex();
  await index.addAll();
  await index.write();
  const oid = await index.writeTree();
  const HEAD = await Git.Reference.nameToId(repository, 'HEAD');
  const parent = await repository.getCommit(HEAD);

  const now = moment().utc().unix();
  const author = Git.Signature.create('Zorgbort', 'info@iliosproject.org', now, 0);
  const commit = await repository.createCommit('HEAD', author, author, message, oid, [parent]);

  await repository.createTag(commit, name, message);

  const appRoot = require('app-root-path');
  const sshPublicKeyPath = appRoot + '/ssh-keys/zorgbort.pub';
  const sshPrivateKeyPath = appRoot + '/ssh-keys/zorgbort';
  const opts = {
    callbacks: {
      credentials: function(url, userName) {
        return Git.Cred.sshKeyNew(
          userName,
          sshPublicKeyPath,
          sshPrivateKeyPath,
          SSH_KEY_PASSPHRASE
        );
      }
    }
  };
  const remote = await Git.Remote.lookup(repository, 'origin');
  return await remote.push([
    'refs/heads/master:refs/heads/master',
    `refs/tags/${name}:refs/tags/${name}`,
  ], opts);
};

const createTempDirectory = async (name) => {
  const appRoot = require('app-root-path');
  const dir = `${appRoot}/tmp/${name}/` + getUniqueId();
  const exists = await fs.exists(dir);
  if (exists) {
    throw new Error(`Tried to create directory, but it already exists: ${dir}`);
  }
  mkdirp(dir);

  return dir;
};

const removeTempDirectory = async (name) => {
  const dir = `/tmp/${name}/` + getUniqueId();

  return await rmdir(dir, err => {
    console.error(err);
  });
};

const releaseAndTag = async (owner, repo, releaseType) => {
  const dir = await createTempDirectory(repo);
  await cloneRepository(owner, repo, dir);

  const plainVerion = await incrementPackageVersion(dir, releaseType);
  const version = `v${plainVerion}`;
  const releaseName = await uniqueReleaseName(Github, cheeseName, owner, repo);
  const releaseNotes = await generateReleaseNotes(Github, Handlebars, fs, owner, repo, releaseName, version);
  await commitAndTag(dir, version, releaseName);
  await removeTempDirectory(repo);

  const release = await Github.repos.createRelease({
    owner,
    repo,
    tag_name: version,
    name: releaseName,
    body: releaseNotes,
    draft: true
  });
  const releaseUrl = release.data.html_url;

  return {
    version,
    releaseName,
    releaseUrl
  };
};

const releaseConversation = (bot, message, owner, repo) => {
  bot.startConversation(message, function(err, convo) {
    convo.ask('Is this a feature or a bugfix release?', [
      {
        pattern: '(feature|bugfix)',
        callback: (response, convo) => {
          convo.say(`Ok, starting ${response.text} release for ${owner}:${repo}`);
          convo.next();
        }
      },
      {
        default: true,
        callback: function(response, convo) {
          convo.say("Sorry that's not what I asked...");
          convo.repeat();
          convo.next();
        }
      }
    ], {'key': 'releaseType'});

    convo.on('end', async convo => {
      if (convo.status == 'completed') {
        try {
          const releaseType = convo.extractResponse('releaseType');
          const npmType = releaseType === 'bugfix'?'patch':'minor';
          const result = await releaseAndTag(owner, repo, npmType);

          bot.reply(message, `:rocket: ${owner}:${repo} ${result.version} ${result.releaseName} has been released. :tada:`);
          bot.reply(message, `Please review and published the release notes at ${result.version} at ${result.releaseUrl}`);
        } catch (e) {
          bot.reply(message, `Error: ${e.message} (stack trace in logs)`);
          console.error(e);
        }


      } else {
        bot.reply(message, 'OK, nevermind!');
      }
    });
  });
};

// module.exports = bot => {
//   bot.hears('releaase frontend', 'direct_message,direct_mention,mention', (bot, message) => {
//     const owner = 'ilios';
//     const repo = 'frontend';
//     releaseConversation(bot, message, owner, repo);
//   });
// };

module.exports = bot => {
  bot.hears('test release', 'direct_message,direct_mention,mention', (bot, message) => {
    const owner = 'jrjohnson';
    const repo = 'test-releaser';
    releaseConversation(bot, message, owner, repo);
  });
};