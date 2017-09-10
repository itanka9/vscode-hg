/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/



import { ExtensionContext, workspace, window, Disposable, commands, languages, Hover, Uri, OutputChannel } from 'vscode';
import { HgFinder, Hg, IHg, HgFindAttemptLogger } from './hg';
import { Model } from './model';
import { MercurialSCMProvider } from './scmProvider';
import { CommandCenter } from './commands';
import { StatusBarCommands } from './statusbar';
import { HgContentProvider } from './contentProvider';
import { BlameAnnotationsProvider } from './blameProvider';
import { AutoIncomingOutgoing } from './autoinout';
import { MergeDecorator } from './merge';
import * as nls from 'vscode-nls';

const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();

async function init(context: ExtensionContext, disposables: Disposable[]): Promise<void> {
	const { name, version, aiKey } = require(context.asAbsolutePath('./package.json')) as { name: string, version: string, aiKey: string };

	const outputChannel = window.createOutputChannel('Hg');
	disposables.push(outputChannel);

	const config = workspace.getConfiguration('hg');
	const enabled = config.get<boolean>('enabled') === true;
	const enableInstrumentation = config.get<boolean>('instrumentation') === true;
	const workspaceRootPath = workspace.rootPath;

	const pathHint = workspace.getConfiguration('hg').get<string>('path');
	const info: IHg = await findHg(pathHint, outputChannel);
	const hg = new Hg({ hgPath: info.path, version: info.version, enableInstrumentation });
	
	if (!workspaceRootPath || !enabled) {
		const commandCenter = new CommandCenter(hg, undefined, outputChannel);
		disposables.push(commandCenter);
		return;
	}

	const model = new Model(hg, workspaceRootPath);

	outputChannel.appendLine(localize('using hg', "Using hg {0} from {1}", info.version, info.path));
	hg.onOutput(str => outputChannel.append(str), null, disposables);

	const commandCenter = new CommandCenter(hg, model, outputChannel);
	const statusBarCommands = new StatusBarCommands(model);
	const provider = new MercurialSCMProvider(model, commandCenter, statusBarCommands);
	const contentProvider = new HgContentProvider(model);
	const autoInOut = new AutoIncomingOutgoing(model);
	const mergeDecorator = new MergeDecorator(model);
	const blameAnnotationsProvider = new BlameAnnotationsProvider(model);

	disposables.push(
		commandCenter,
		provider,
		contentProvider,
		autoInOut,
		mergeDecorator,
		blameAnnotationsProvider,
		model
	);

	if (/^[01]/.test(info.version)) {
		const update = localize('updateHg', "Update Hg");
		const choice = await window.showWarningMessage(localize('hg20', "You seem to have hg {0} installed. Code works best with hg >= 2", info.version), update);

		if (choice === update) {
			commands.executeCommand('vscode.open', Uri.parse('https://mercurial-scm.org/'));
		}
	}
}

export async function findHg(pathHint: string | undefined, outputChannel: OutputChannel): Promise<IHg> {
	const logger = {
		attempts: <string[]>[],
		log: (path: string) => logger.attempts.push(path)
	}

	try {
		const finder = new HgFinder(logger);
		return await finder.find(pathHint);
	}
	catch (e) {
		outputChannel.appendLine("Could not find hg, tried:")
		logger.attempts.forEach(attempt => outputChannel.appendLine(` - ${attempt}`));
		throw e;
	}
}

export function activate(context: ExtensionContext) {
	const disposables: Disposable[] = [];
	context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

	init(context, disposables)
		.catch(err => console.error(err));
}