export namespace imgread {
	
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
	export class PanelState {
	    tabs: TabState[];
	    activeIndex: number;
	
	    static createFrom(source: any = {}) {
	        return new PanelState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
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
	export class PanelCoordSt {
	    row: number;
	    col: number;
	
	    static createFrom(source: any = {}) {
	        return new PanelCoordSt(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.row = source["row"];
	        this.col = source["col"];
	    }
	}
	export class GridState {
	    rows: number;
	    cols: number;
	    rowSizes: number[];
	    colSizes: number[];
	    active: PanelCoordSt;
	    panels: PanelState[];
	
	    static createFrom(source: any = {}) {
	        return new GridState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rows = source["rows"];
	        this.cols = source["cols"];
	        this.rowSizes = source["rowSizes"];
	        this.colSizes = source["colSizes"];
	        this.active = this.convertValues(source["active"], PanelCoordSt);
	        this.panels = this.convertValues(source["panels"], PanelState);
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
	    grid: GridState;
	
	    static createFrom(source: any = {}) {
	        return new StateData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.rootPath = source["rootPath"];
	        this.leftPaneWidth = source["leftPaneWidth"];
	        this.window = this.convertValues(source["window"], WindowState);
	        this.grid = this.convertValues(source["grid"], GridState);
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

export namespace tree {
	
	export class Node {
	    path: string;
	    name: string;
	    kind: string;
	    mtime: number;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new Node(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.kind = source["kind"];
	        this.mtime = source["mtime"];
	        this.size = source["size"];
	    }
	}

}

