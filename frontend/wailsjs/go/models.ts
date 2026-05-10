export namespace classification {
	
	export class ChildSidecarSummary {
	    subfolder: string;
	    source: string;
	    entryCount: number;
	    nonEmptyCount: number;
	
	    static createFrom(source: any = {}) {
	        return new ChildSidecarSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.subfolder = source["subfolder"];
	        this.source = source["source"];
	        this.entryCount = source["entryCount"];
	        this.nonEmptyCount = source["nonEmptyCount"];
	    }
	}
	export class Entry {
	    filename: string;
	    folder: string;
	    confidence: string;
	    note: string;
	
	    static createFrom(source: any = {}) {
	        return new Entry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.filename = source["filename"];
	        this.folder = source["folder"];
	        this.confidence = source["confidence"];
	        this.note = source["note"];
	    }
	}
	export class LoadResult {
	    folderPath: string;
	    entries: Entry[];
	    orphans: Entry[];
	    hasSidecar: boolean;
	    source: string;
	    mtime: number;
	
	    static createFrom(source: any = {}) {
	        return new LoadResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.folderPath = source["folderPath"];
	        this.entries = this.convertValues(source["entries"], Entry);
	        this.orphans = this.convertValues(source["orphans"], Entry);
	        this.hasSidecar = source["hasSidecar"];
	        this.source = source["source"];
	        this.mtime = source["mtime"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class MergePreview {
	    folderPath: string;
	    children: ChildSidecarSummary[];
	    hasNonTrivial: boolean;
	    totalEntries: number;
	    totalNonEmpty: number;
	
	    static createFrom(source: any = {}) {
	        return new MergePreview(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.folderPath = source["folderPath"];
	        this.children = this.convertValues(source["children"], ChildSidecarSummary);
	        this.hasNonTrivial = source["hasNonTrivial"];
	        this.totalEntries = source["totalEntries"];
	        this.totalNonEmpty = source["totalNonEmpty"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SaveOutput {
	    mtime: number;
	
	    static createFrom(source: any = {}) {
	        return new SaveOutput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.mtime = source["mtime"];
	    }
	}

}

export namespace imgread {
	
	export class Info {
	    width: number;
	    height: number;
	    mimeType: string;
	
	    static createFrom(source: any = {}) {
	        return new Info(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.width = source["width"];
	        this.height = source["height"];
	        this.mimeType = source["mimeType"];
	    }
	}
	export class Result {
	    data: number[];
	    mimeType: string;
	    width: number;
	    height: number;
	
	    static createFrom(source: any = {}) {
	        return new Result(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.data = source["data"];
	        this.mimeType = source["mimeType"];
	        this.width = source["width"];
	        this.height = source["height"];
	    }
	}

}

export namespace state {
	
	export class TabState {
	    path: string;
	    zoom: number;
	    panX: number;
	    panY: number;
	
	    static createFrom(source: any = {}) {
	        return new TabState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.zoom = source["zoom"];
	        this.panX = source["panX"];
	        this.panY = source["panY"];
	    }
	}
	export class LayoutNodeState {
	    kind: string;
	    id: string;
	    direction?: string;
	    ratio?: number;
	    a?: LayoutNodeState;
	    b?: LayoutNodeState;
	    tabs?: TabState[];
	    activeIndex: number;
	
	    static createFrom(source: any = {}) {
	        return new LayoutNodeState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.id = source["id"];
	        this.direction = source["direction"];
	        this.ratio = source["ratio"];
	        this.a = this.convertValues(source["a"], LayoutNodeState);
	        this.b = this.convertValues(source["b"], LayoutNodeState);
	        this.tabs = this.convertValues(source["tabs"], TabState);
	        this.activeIndex = source["activeIndex"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LayoutState {
	    root: LayoutNodeState;
	    activeId: string;
	
	    static createFrom(source: any = {}) {
	        return new LayoutState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = this.convertValues(source["root"], LayoutNodeState);
	        this.activeId = source["activeId"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ListFilterState {
	    tags: string[];
	    confidence: string;
	    query: string;
	
	    static createFrom(source: any = {}) {
	        return new ListFilterState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.tags = source["tags"];
	        this.confidence = source["confidence"];
	        this.query = source["query"];
	    }
	}
	export class ListTabState {
	    folderPath: string;
	    filter: ListFilterState;
	    collapsedGroups: string[];
	
	    static createFrom(source: any = {}) {
	        return new ListTabState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.folderPath = source["folderPath"];
	        this.filter = this.convertValues(source["filter"], ListFilterState);
	        this.collapsedGroups = source["collapsedGroups"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class WindowState {
	    width: number;
	    height: number;
	    x: number;
	    y: number;
	
	    static createFrom(source: any = {}) {
	        return new WindowState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.width = source["width"];
	        this.height = source["height"];
	        this.x = source["x"];
	        this.y = source["y"];
	    }
	}
	export class StateData {
	    version: number;
	    rootPath: string;
	    leftPaneWidth: number;
	    window: WindowState;
	    layout: LayoutState;
	    topTab: string;
	    list: ListTabState;
	
	    static createFrom(source: any = {}) {
	        return new StateData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.rootPath = source["rootPath"];
	        this.leftPaneWidth = source["leftPaneWidth"];
	        this.window = this.convertValues(source["window"], WindowState);
	        this.layout = this.convertValues(source["layout"], LayoutState);
	        this.topTab = source["topTab"];
	        this.list = this.convertValues(source["list"], ListTabState);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	

}

export namespace thumb {
	
	export class Result {
	    data: number[];
	    mimeType: string;
	
	    static createFrom(source: any = {}) {
	        return new Result(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.data = source["data"];
	        this.mimeType = source["mimeType"];
	    }
	}

}

