#!/usr/bin/env node
/**
 * `themeseed` — the command-line entry point.
 *
 * commander for parsing, @clack/prompts for the interactive parts. The choice
 * is documented in the README; the short version is that commander gives
 * conventional `--help`/`--version` behaviour for free and clack's prompts are
 * the least intrusive of the interactive libraries in a terminal that may be
 * piped or non-TTY.
 */

import { Command } from 'commander';
import pc from 'picocolors';

import { loadUserEnv } from '../config/env.js';
import { describeError, ThemeseedError } from '../core/errors.js';
import { setLogLevel, type LogLevel } from '../core/logger.js';
import { readVersion } from '../core/version.js';
import {
  analyzeCommand,
  listCommand,
  seedCommand,
  wipeCommand,
} from './commands/content.js';
import { imagesCommand } from './commands/images.js';
import { initCommand } from './commands/init.js';
import { installCommand, printMcpConfig, uninstallCommand } from './commands/install.js';
import {
  addSiteCommand,
  listSitesCommand,
  removeSiteCommand,
  setDefaultSiteCommand,
} from './commands/sites.js';
import { upgradeCommand } from './commands/upgrade.js';

// Read the same ~/.themeseed/.env the MCP server reads, so both surfaces see
// the same provider keys regardless of the directory they were started in.
loadUserEnv();

const program = new Command();

program
  .name('themeseed')
  .description(
    'Seed realistic demo content into a CMS so you can preview a theme with real-looking\n' +
      'articles, images, galleries and video — instead of an empty install.\n\n' +
      'Ghost is supported today. WordPress, Joomla, Drupal and Magento are planned;\n' +
      'see CONTRIBUTING.md to add one.'
  )
  .version(await readVersion(), '-v, --version', 'Print the installed version')
  .helpOption('-h, --help', 'Show this help')
  .option('--log-level <level>', 'silent | error | warn | info | debug', 'info')
  .hook('preAction', (thisCommand) => {
    const level = thisCommand.opts()['logLevel'] as LogLevel | undefined;
    if (level) setLogLevel(level);
  });

// --- setup -----------------------------------------------------------------

program
  .command('init')
  .description(
    'First-run setup: register the MCP server with your editors and add a site'
  )
  .option('-y, --yes', 'Accept defaults without prompting')
  .option('--registry <url>', 'npm registry to install from')
  .option('--skip-editors', 'Do not touch any editor configuration')
  .option('--skip-images', 'Do not prompt for image providers')
  .option('--skip-site', 'Do not prompt to add a site')
  .action((options) => initCommand(options));

program
  .command('install')
  .description(
    'Register the themeseed MCP server with an editor (without the full init flow)'
  )
  .option('-t, --tool <id...>', 'Tool ids to configure, e.g. claude-code cursor')
  .option('-a, --all', 'Configure every detected tool')
  .option('-y, --yes', 'Do not prompt')
  .option('--registry <url>', 'npm registry to reference in the generated config')
  .action((options) => installCommand(options));

program
  .command('uninstall')
  .description('Remove the themeseed MCP server from editor configuration')
  .option('-t, --tool <id...>', 'Tool ids to clean up')
  .option('-a, --all', 'Remove from every detected tool')
  .action((options) => uninstallCommand(options));

program
  .command('mcp-config')
  .description('Print the MCP server JSON snippet for manual configuration')
  .option('--registry <url>', 'npm registry to reference')
  .action((options) => printMcpConfig(options.registry));

program
  .command('images')
  .description('Configure where post images come from (stock, AI or a local folder)')
  .option('--list', 'Show which providers are configured')
  .option('--set <provider>', 'Configure one provider without prompting')
  .option(
    '--key <value>',
    'API key for --set, or a directory path for `--set local`. Prefer the prompt — a key passed as a flag lands in shell history'
  )
  .option('--remove <provider>', 'Forget a provider key')
  .action((options) => imagesCommand(options));

program
  .command('upgrade')
  .description('Check the registry for a newer themeseed and install it')
  .option('--check', 'Report whether an update exists without installing')
  .option('-y, --yes', 'Do not prompt for confirmation')
  .option('--registry <url>', 'npm registry to check')
  .action((options) => upgradeCommand(options));

// --- sites -----------------------------------------------------------------

program
  .command('add-site')
  .description('Register a CMS to seed (credentials are verified before saving)')
  .option('-s, --slug <slug>', 'Short identifier for the site')
  .option('-p, --platform <platform>', 'CMS platform', 'ghost')
  .option('-u, --url <url>', 'Base URL of the site')
  .option(
    '-k, --key <key>',
    'API key. Prefer the interactive prompt — a key passed as a flag lands in shell history'
  )
  .option('--themes-dir <path>', 'Path to the CMS themes directory on this machine')
  .action((options) => addSiteCommand(options));

program
  .command('remove-site [slug]')
  .description('Forget a site (local configuration only — no content is deleted)')
  .option('-y, --yes', 'Do not prompt for confirmation')
  .action((slug, options) => removeSiteCommand(slug, options));

program
  .command('list-sites')
  .description('List configured sites')
  .action(listSitesCommand);

program
  .command('use <slug>')
  .description('Set the default site used when no slug is given')
  .action((slug) => setDefaultSiteCommand(slug));

// --- content ---------------------------------------------------------------

program
  .command('analyze [site]')
  .description("Inspect a site's active theme and report what it can display")
  .option('--json', 'Print the raw capabilities object')
  .action((site, options) => analyzeCommand(site, options));

program
  .command('seed [site]')
  .description(
    'Generate and publish demo content (add --study-theme to shape it to the active theme)'
  )
  .option(
    '-t, --topic <topic>',
    'What the publication is about, e.g. "SaaS productivity blog"'
  )
  .option(
    '-c, --count <n>',
    'How many posts to create',
    (value) => Number.parseInt(value, 10),
    12
  )
  .option(
    '-i, --image-source <source>',
    'auto | local | stock | ai | none. auto uses AI if a key is set, else stock, else no images',
    'auto'
  )
  .option(
    '--study-theme',
    "Read the site's active theme and shape content to it (costs an extra round trip)"
  )
  .option('--draft', 'Create drafts instead of published posts')
  .option('--author <name>', 'Author name to attribute posts to')
  .option('--no-video', 'Skip YouTube lookups')
  .option('--seed <n>', 'Seed the generator for reproducible output', (value) =>
    Number.parseInt(value, 10)
  )
  .option('-y, --yes', 'Do not prompt for confirmation')
  .action((site, options) => seedCommand(site, options));

program
  .command('list [site]')
  .description('List content themeseed created on a site')
  .option('--json', 'Print raw JSON')
  .action((site, options) => listCommand(site, options));

program
  .command('wipe [site]')
  .description('Delete everything themeseed created on a site (tagged #themeseed)')
  .option('-y, --yes', 'Do not prompt for confirmation')
  .action((site, options) => wipeCommand(site, options));

program.addHelpText(
  'after',
  `
${pc.bold('Examples')}
  ${pc.dim('$')} themeseed init                                  ${pc.dim('# first-run setup')}
  ${pc.dim('$')} themeseed add-site --slug blog --url http://localhost:2368
  ${pc.dim('$')} themeseed analyze blog                          ${pc.dim('# what can this theme display?')}
  ${pc.dim('$')} themeseed seed blog -t "SaaS productivity blog" -c 15
  ${pc.dim('$')} themeseed wipe blog                             ${pc.dim('# remove it all again')}

${pc.bold('MCP')}
  The same operations are available to any MCP client as the tools
  analyze_theme, generate_posts, list_seeded, wipe_seeded, add_site,
  list_sites and remove_site. Run ${pc.cyan('themeseed install')} to register the server.

Configuration lives in ${pc.cyan('~/.themeseed/sites.json')} and never in a repository.
`
);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    console.error(`\n${pc.red('✖')} ${describeError(err)}`);
    if (!(err instanceof ThemeseedError) && process.env.THEMESEED_LOG_LEVEL === 'debug') {
      console.error(err);
    }
    process.exit(1);
  }
}

await main();
