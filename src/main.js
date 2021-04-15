const fs = require("fs").promises,
    util = require("util"),
    glob = util.promisify(require("glob")),
    { isText } = require('istextorbinary'),
    core = require("@actions/core"),
    github = require("@actions/github");

const REPO_DIRECTORY = process.env["GITHUB_WORKSPACE"],
    token = process.env["GITHUB_TOKEN"],
    context = github.context,
    owner = context.repo.owner,
    client = new github.GitHub(token),
    repo = context.repo.repo;

const getEvent = async () => JSON.parse(await fs.readFile(process.env["GITHUB_EVENT_PATH"]));

async function run() {
    try {
        core.debug(JSON.stringify(context.payload));
        if (github.context.eventName != "pull_request") {
            core.info("This action is supposed to run for pushes to pull requests only. Skipping...");
            return;
        }
        const event = await getEvent();
        if (!["synchronize", "opened"].includes(event.action)) {
            core.info("This action is supposed to run for pushes to pull requests only. Skipping...");
            return;
        }
        await push();
    }
    catch (err) {
        //Even if it's a valid situation, we want to fail the action in order to be able to find the issue and fix it.
        core.setFailed(err.message);
        core.debug(JSON.stringify(err));
    }
}

function getLineBreakChar(string) {
    const indexOfLF = string.indexOf('\n', 1);  // No need to check first-character

    if (indexOfLF === -1) {
        if (string.indexOf('\r') !== -1) {
            return '\r';
        }
        return '\n';
    }

    if (string[indexOfLF - 1] === '\r') {
        return '\r\n';
    }

    return '\n';
}

async function processFiles() {
    const paths = await glob(`${REPO_DIRECTORY}/**`, {
        nodir: true,
    }),
        files = [];
    let page = 0,
        changedFiles;
    core.info("Looking for changed files...");
    do {
        core.info(`Page ${++page}:`);
        changedFiles = await client.pulls.listFiles({
            owner,
            page,
            pull_number: context.payload.pull_request.number,
            repo,
        });
        core.debug(JSON.stringify(changedFiles.data));
        for (const element of changedFiles.data) {
            if (!paths.includes(`${REPO_DIRECTORY}/${element.filename}`)) {
                core.info(`${element.filename} is ignored. Skipping...`);
                continue;
            }
            if (!isText(element.filename)) {
                core.info(`${element.filename} is not a text file. Skipping...`);
                continue;
            }
            const file = await fs.readFile(element.filename, { encoding: "utf8" });
            if (file.endsWith("\n") || file.endsWith("\r")) {
                core.info(`${element.filename} is not compromised. Skipping...`);
                continue;
            }
            core.info(`${element.filename} is compromised. Fixing...`);
            const newFile = file.concat(getLineBreakChar(file));
            await fs.writeFile(element.filename, newFile);
            files.push(element.filename);
        }
    } while (changedFiles.data.length == 100);
    return files;
}

function generateMarkdownReport(results) {
    const ret = `
${results.length} file(s) are missing a line break at their end"}:
${results.map(function (element) {
        return `- \`${element}\`\n`;
    })}`;
    core.debug(ret);
    return ret;
}

async function createComment(body) {
    const comment = await client.issues.createComment({
        body,
        issue_number: context.payload.pull_request.number,
        owner,
        repo,
    });
    core.debug(JSON.stringify(comment.data));
}

async function push() {
    core.info("Locating files...");
    const results = await processFiles();
    if (!results.length) {
        core.info("No compromised files found. Skipping...");
        return;
    }

    core.info("Generating markdown report...");
    const markdown = generateMarkdownReport(results);

    core.info("Leaving comment on PR...");
    await createComment(markdown);
}

run();
