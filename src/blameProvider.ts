/**
 *  Based on AnnotationProviderBase, BlameAnnotationProvider classes of
 *  vscode-gitlens extension 
 */
import { 
    DecorationOptions
    , DecorationRenderOptions
    , Disposable
    , Position
    , Range
    , ExtensionContext
    , TextDocument
    , TextEditor
    , TextEditorDecorationType
    , TextEditorSelectionChangeEvent
    , window
    , workspace 
} from 'vscode';
import { Model, Blame, BlameLineInfo } from './model';


export const Decorations = {
    blameAnnotation: window.createTextEditorDecorationType({
        isWholeLine: true,
        textDecoration: 'none'
    } as DecorationRenderOptions),
};

const endOfLineIndex = 1000000;

export class BlameAnnotationsProvider extends Disposable {

    private cachedBlames: { [key:string]: Blame } = {};
    protected _disposable: Disposable;

    constructor (private model: Model) {
        super(() => this.dispose());

        const subscriptions: Disposable[] = [];
        
        subscriptions.push(window.onDidChangeTextEditorSelection(this._onTextEditorSelectionChanged, this));

        subscriptions.push(window.onDidChangeActiveTextEditor(this._onActiveTextEditorChanged, this));

        subscriptions.push(workspace.onDidOpenTextDocument(this._onDocumentChanged, this));
        
        this._disposable = Disposable.from(...subscriptions);

        
    }

    private async _onDocumentChanged(e: TextDocument) {
        for (const editor of window.visibleTextEditors) {
            this._onActiveTextEditorChanged(editor);
        }
    }

    private async _onActiveTextEditorChanged(e: TextEditor) {
        if (!e)
            return;
        const path = e.document.uri.fsPath;
        if (this.cachedBlames[path] === undefined) {
            this.cachedBlames[path] = await this.model.blame(path);
        }
        const blameInfo = this.cachedBlames[path]
        const decorators: DecorationOptions[] = [];
        
        blameInfo.allLines().forEach(lineInfo => {
            const range =  e.document.validateRange(new Range(
                lineInfo.line, 0, 
                lineInfo.line, Infinity
            ));
            
            decorators.push({
                hoverMessage: `${lineInfo.commitHash}: ${lineInfo.user}`,
                range: range
            } as DecorationOptions);                        
        });

        e.setDecorations(Decorations.blameAnnotation, decorators);
    }

    private async _onTextEditorSelectionChanged(e: TextEditorSelectionChangeEvent) {
        return this.selection(e.selections[0].active.line);
    }

    private async selection(shaOrLine?: string | number): Promise<void> {
    }
}