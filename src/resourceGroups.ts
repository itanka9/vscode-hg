import { Resource, MergeStatus, Status } from "./model";
import { HgError, IFileStatus, IRepoStatus } from "./hg";
import { Uri } from "vscode";
import * as path from "path";
import * as nls from "vscode-nls";
import * as fs from "fs";

const localize = nls.loadMessageBundle();

export interface IGroupStatusesParams {
	respositoryRoot: string
	statusGroups: IStatusGroups,
	fileStatuses: IFileStatus[],
	repoStatus: IRepoStatus,
	resolveStatuses: IFileStatus[] | undefined,
}

export interface IStatusGroups {
	conflict: ConflictGroup;
	staging: StagingGroup;
	merge: MergeGroup;
	working: WorkingDirectoryGroup;
	untracked: UntrackedGroup;
}

export type ResourceGroupId = keyof IStatusGroups;

export function createEmptyStatusGroups(): IStatusGroups {
	return {
		conflict: new ConflictGroup(),
		staging: new StagingGroup(),
		merge: new MergeGroup(),
		working: new WorkingDirectoryGroup(),
		untracked: new UntrackedGroup()
	}
}

export abstract class ResourceGroup {
	get id(): ResourceGroupId { return this._id; }
	get contextKey(): string { return this._id; }
	get label(): string { return this._label; }
	get resources(): Resource[] { return this._resources; }

	private _resourceUriIndex: Map<string, boolean>;

	constructor(
		private _id: ResourceGroupId,
		private _label: string,
		private _resources: Resource[]) {
		this._resourceUriIndex = ResourceGroup.indexResources(_resources);
	}

	private static indexResources(resources: Resource[]): Map<string, boolean> {
		const index = new Map<string, boolean>();
		resources.forEach(r => index.set(r.resourceUri.toString(), true));
		return index;
	}

	getResource(uri: Uri): Resource | undefined {
		const uriString = uri.toString();
		return this.resources.filter(r => r.resourceUri.toString() === uriString)[0];
	}

	includes(resource: Resource): boolean {
		return this.includesUri(resource.resourceUri);
	}

	includesUri(uri: Uri): boolean {
		return this._resourceUriIndex.has(uri.toString());
	}

	intersect(resources: Resource[]): this {
		const newUniqueResources = resources.filter(r => !this.includes(r)).map(r => new Resource(this, r.resourceUri, r.status, r.mergeStatus));
		const intersectionResources: Resource[] = [...this.resources, ...newUniqueResources];
		return this.newResourceGroup(intersectionResources);
	}

	except(resources: Resource[]): this {
		const excludeIndex = ResourceGroup.indexResources(resources);
		const remainingResources = this.resources.filter(r => !excludeIndex.has(r.resourceUri.toString()));
		return this.newResourceGroup(remainingResources);
	}

	private newResourceGroup(resources: Resource[]): this {
		const SubClassConstructor = Object.getPrototypeOf(this).constructor;
		return new SubClassConstructor(resources);
	}
}

export class MergeGroup extends ResourceGroup {
	static readonly ID = 'merge';

	constructor(resources: Resource[] = []) {
		super(MergeGroup.ID, localize('merged changes', "Merged Changes"), resources);
	}
}

export class ConflictGroup extends ResourceGroup {
	static readonly ID = 'conflict';

	constructor(resources: Resource[] = []) {
		super(ConflictGroup.ID, localize('merge conflicts', "Unresolved Conflicts"), resources);
	}
}

export class StagingGroup extends ResourceGroup {
	static readonly ID = 'staging';

	constructor(resources: Resource[] = []) {
		super(StagingGroup.ID, localize('staged changes', "Staged Changes"), resources);
	}
}

export class UntrackedGroup extends ResourceGroup {
	static readonly ID = 'untracked';

	constructor(resources: Resource[] = []) {
		super(UntrackedGroup.ID, localize('untracked files', "Untracked Files"), resources);
	}
}

export class WorkingDirectoryGroup extends ResourceGroup {
	static readonly ID = 'working';

	constructor(resources: Resource[] = []) {
		super(WorkingDirectoryGroup.ID, localize('changes', "Changes"), resources);
	}
}

export function groupStatuses({
	respositoryRoot,
	statusGroups: { conflict, staging, merge, working, untracked },
	fileStatuses,
	repoStatus,
	resolveStatuses
}: IGroupStatusesParams): IStatusGroups {
	const workingDirectoryResources: Resource[] = [];
	const stagingResources: Resource[] = [];
	const conflictResources: Resource[] = [];
	const mergeResources: Resource[] = [];
	const untrackedResources: Resource[] = [];

	const chooseResourcesAndGroup = (uriString: string, rawStatus: string, mergeStatus: MergeStatus, renamed: boolean): [Resource[], ResourceGroup, Status] => {
		let status: Status;
		switch (rawStatus) {
			case 'M': status = Status.MODIFIED; break;
			case 'R': status = Status.DELETED; break;
			case 'I': status = Status.IGNORED; break;
			case '?': status = Status.UNTRACKED; break;
			case '!': status = Status.MISSING; break;
			case 'A': status = renamed ? Status.RENAMED : Status.ADDED; break;
			case 'C': status = Status.CLEAN; break;
			default: throw new HgError({ message: "Unknown rawStatus: " + rawStatus })
		}

		if (status === Status.IGNORED || status === Status.UNTRACKED) {
			return [untrackedResources, untracked, status]
		}

		if (repoStatus.isMerge) {
			if (mergeStatus === MergeStatus.UNRESOLVED) {
				return [conflictResources, conflict, status];
			}
			return [mergeResources, merge, status];
		}

		const isStaged = staging.resources.some(resource => resource.resourceUri.toString() === uriString);
		const targetResources: Resource[] = isStaged ? stagingResources : workingDirectoryResources;
		const targetGroup: ResourceGroup = isStaged ? staging : working;
		return [targetResources, targetGroup, status];
	};

	const seenUriStrings: Map<string, boolean> = new Map();

	for (const raw of fileStatuses) {
		const uri = Uri.file(path.join(respositoryRoot, raw.path));
		const uriString = uri.toString();
		seenUriStrings.set(uriString, true);
		const renameUri = raw.rename ? Uri.file(path.join(respositoryRoot, raw.rename)) : undefined;
		const resolveFile = resolveStatuses && resolveStatuses.filter(res => res.path === raw.path)[0];
		const mergeStatus = resolveFile ? toMergeStatus(resolveFile.status) : MergeStatus.NONE;
		const [resources, group, status] = chooseResourcesAndGroup(uriString, raw.status, mergeStatus, !!raw.rename);
		resources.push(new Resource(group, uri, status, mergeStatus, renameUri));
	}

	// it is possible for a clean file to need resolved
	// e.g. when local changed and other deleted
	if (resolveStatuses) {
		for (const raw of resolveStatuses) {
			const uri = Uri.file(path.join(respositoryRoot, raw.path));
			const uriString = uri.toString();
			if (seenUriStrings.has(uriString)) {
				continue; // dealt with by the fileStatuses (this is the norm)
			}
			const mergeStatus = toMergeStatus(raw.status);
			const inferredStatus: string = fs.existsSync(uri.fsPath) ? 'C' : 'R';
			const [resources, group, status] = chooseResourcesAndGroup(uriString, inferredStatus, mergeStatus, !!raw.rename);
			resources.push(new Resource(group, uri, status, mergeStatus));
		}
	}

	return {
		conflict: new ConflictGroup(conflictResources),
		merge: new MergeGroup(mergeResources),
		staging: new StagingGroup(stagingResources),
		working: new WorkingDirectoryGroup(workingDirectoryResources),
		untracked: new UntrackedGroup(untrackedResources)
	}
}

function toMergeStatus(status: string): MergeStatus {
	switch (status) {
		case 'R': return MergeStatus.RESOLVED;
		case 'U': return MergeStatus.UNRESOLVED;
		default: return MergeStatus.NONE;
	}
}

/** The type of argument that is returned for a command executed on a "scm/resourceGroup/context" */
export interface ResourceGroupProxy {
	_id: ResourceGroupId;
}

export const isResourceGroupProxy = (obj: any): obj is ResourceGroupProxy => (<ResourceGroupProxy>obj)._id !== undefined;