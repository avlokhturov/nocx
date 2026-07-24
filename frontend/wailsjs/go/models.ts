export namespace update {
	
	export class UpdateInfo {
	    Version: string;
	    NotesURL: string;
	    URL: string;
	    SHA256: string;
	    Size: number;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.Version = source["Version"];
	        this.NotesURL = source["NotesURL"];
	        this.URL = source["URL"];
	        this.SHA256 = source["SHA256"];
	        this.Size = source["Size"];
	    }
	}

}

