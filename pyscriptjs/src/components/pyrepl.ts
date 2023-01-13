import { basicSetup, EditorView } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { indentUnit } from '@codemirror/language';
import { Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { oneDarkTheme } from '@codemirror/theme-one-dark';

import { getAttribute, ensureUniqueId, htmlDecode } from '../utils';
import type { Runtime } from '../runtime';
import { pyExec, pyDisplay } from '../pyexec';
import { getLogger } from '../logger';

const logger = getLogger('py-repl');
const RUNBUTTON = `<svg style="height:20px;width:20px;vertical-align:-.125em;transform-origin:center;overflow:visible;color:green" viewBox="0 0 384 512" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg"><g transform="translate(192 256)" transform-origin="96 0"><g transform="translate(0,0) scale(1,1)"><path d="M361 215C375.3 223.8 384 239.3 384 256C384 272.7 375.3 288.2 361 296.1L73.03 472.1C58.21 482 39.66 482.4 24.52 473.9C9.377 465.4 0 449.4 0 432V80C0 62.64 9.377 46.63 24.52 38.13C39.66 29.64 58.21 29.99 73.03 39.04L361 215z" fill="currentColor" transform="translate(-192 -256)"></path></g></g></svg>`;

export function make_PyRepl(runtime: Runtime) {
    /* High level structure of py-repl DOM, and the corresponding JS names.

           this             <py-repl>
           shadow               #shadow-root
                                    <slot></slot>
           boxDiv               <div class='py-repl-box'>
           editorLabel              <label>...</label>
           editorDiv                <div class="py-repl-editor"></div>
           outDiv                   <div class="py-repl-output"></div>
                                </div>
                            </py-repl>
    */
    class PyRepl extends HTMLElement {
        shadow: ShadowRoot;
        outDiv: HTMLElement;
        editor: EditorView;

        constructor() {
            super();
        }

        connectedCallback() {
            ensureUniqueId(this);
            this.shadow = this.attachShadow({ mode: 'open' });
            const slot = document.createElement('slot');
            this.shadow.appendChild(slot);

            if (!this.hasAttribute('exec-id')) {
                this.setAttribute('exec-id', '1');
            }
            if (!this.hasAttribute('root')) {
                this.setAttribute('root', this.id);
            }

            const pySrc = htmlDecode(this.innerHTML).trim();
            this.innerHTML = '';
            this.editor = this.makeEditor(pySrc);
            const boxDiv = this.makeBoxDiv();
            this.appendChild(boxDiv);
            this.editor.focus();
            logger.debug(`element ${this.id} successfully connected`);
        }

        /** Create and configure the codemirror editor
         */
        makeEditor(pySrc: string): EditorView {
            const languageConf = new Compartment();
            const extensions = [
                indentUnit.of('    '),
                basicSetup,
                languageConf.of(python()),
                keymap.of([
                    ...defaultKeymap,
                    { key: 'Ctrl-Enter', run: this.execute.bind(this), preventDefault: true },
                    { key: 'Shift-Enter', run: this.execute.bind(this), preventDefault: true },
                ]),
            ];

            if (getAttribute(this, 'theme') === 'dark') {
                extensions.push(oneDarkTheme);
            }

            return new EditorView({
                doc: pySrc,
                extensions,
            });
        }

        // ******** main entry point for py-repl DOM building **********
        //
        // The following functions are written in a top-down, depth-first
        // order (so that the order of code roughly matches the order of
        // execution)
        makeBoxDiv(): HTMLElement {
            const boxDiv = document.createElement('div');
            boxDiv.className = 'py-repl-box';

            const editorDiv = this.makeEditorDiv();
            const editorLabel = this.makeLabel('Python Script Area', editorDiv);
            this.outDiv = this.makeOutDiv();

            boxDiv.append(editorLabel);
            boxDiv.appendChild(editorDiv);
            boxDiv.appendChild(this.outDiv);

            return boxDiv;
        }

        makeEditorDiv(): HTMLElement {
            const editorDiv = document.createElement('div');
            editorDiv.id = 'code-editor';
            editorDiv.className = 'py-repl-editor';
            editorDiv.appendChild(this.editor.dom);

            const runButton = this.makeRunButton();
            const runLabel = this.makeLabel('Python Script Run Button', runButton);
            editorDiv.appendChild(runLabel);
            editorDiv.appendChild(runButton);

            return editorDiv;
        }

        makeLabel(text: string, elementFor: HTMLElement): HTMLElement {
            ensureUniqueId(elementFor);
            const lbl = document.createElement('label');
            lbl.innerHTML = text;
            lbl.htmlFor = elementFor.id;
            // XXX this should be a CSS class
            // Styles that we use to hide the labels whilst also keeping it accessible for screen readers
            const labelStyle = 'overflow:hidden; display:block; width:1px; height:1px';
            lbl.setAttribute('style', labelStyle);
            return lbl;
        }

        makeRunButton(): HTMLElement {
            const runButton = document.createElement('button');
            runButton.id = 'runButton';
            runButton.className = 'absolute py-repl-run-button';
            runButton.innerHTML = RUNBUTTON;
            runButton.addEventListener('click', this.execute.bind(this));
            return runButton;
        }

        makeOutDiv(): HTMLElement {
            const outDiv = document.createElement('div');
            outDiv.className = 'py-repl-output';
            outDiv.id = this.id + '-' + this.getAttribute('exec-id');
            return outDiv;
        }

        //  ********************* execution logic *********************

        /** Execute the python code written in the editor, and automatically
         *  display() the last evaluated expression
         */
        execute(): void {
            logger.info('14:14')

            const pySrc = this.getPySrc();
            logger.info(pySrc);

            // determine the output element
            const outEl = this.getOutputElement();
            if (outEl === undefined) {
                // this happens if we specified output="..." but we couldn't
                // find the ID. We already displayed an error message inside
                // getOutputElement, stop the execution.
                return;
            }

            // clear the old output before executing the new code
            outEl.innerHTML = '';

            // execute the python code
            const pyResult = pyExec(runtime, pySrc, outEl);

            // display the value of the last evaluated expression (REPL-style)
            if (pyResult !== undefined) {
                pyDisplay(runtime, pyResult, { target: outEl.id });
            }

            this.autogenerateMaybe();
        }

        getPrefix(line: string): boolean {
            return line.replaceAll(/\s/g, '').slice(-1) === ")" ? true : false;
        }

        formatPySrc(source: string): string {
            source = source.split('\n').map(line => {
                logger.info('line : ' + line)
                let newLine = line;
                let indentation = line.match(/^[ \t]+/g) ? line.match(/^[ \t]+/g)[0] : ''
                indentation += '    ';
                if (line.includes('Drone()')) {
                    globalThis.droneInstance = line.split("=")[0].replaceAll(" ", "") + ".";
                    newLine = "\n";
                    logger.info('if include Drone()')
                } else if (line.includes('drone.')) {
                    let splitLineByDrone = line.split('drone.');
                    newLine = splitLineByDrone.map((s, i) => {
                        if (i === 0) return s;
                        else if (s.includes('get_color_data')) {
                            // JSProxy to Python array
                            logger.info('including color data');
                            let value_name = line.split('=')[0].replaceAll(' ', '');
                            return `
tmp = await drone.${s}
${value_name} = tmp.to_py()
`
                        } else {
                            return `await drone.${s}`
                        }
                    }).join("");
                    logger.info('new line in drone function : ')
                    logger.info(newLine);
                    if (newLine.includes('get_color_data')) {
                        let value_name = line.split('=')[0].replaceAll(' ', '');
                        newLine = newLine.replace(`${value_name} = \n`, '')
                    }
                    newLine = '    ' + newLine;
                    logger.info('line includes drone.')
                } else if (line.includes('time.sleep')) {
                    // let indentation = line.match(/^[ \t]+/g) ? line.match(/^[ \t]+/g)[0] : ''
                    let seconds = line.split('(')[1].split(')')[0];
                    newLine = `${indentation}await asyncio.sleep(${seconds})`;
                    logger.info('line includes time.sleep')
                } else if (line.includes('from codrone_edu') || line.includes('import codrone_edu')) {
                    newLine = '\n';
                    logger.info('line includes libraries')
                } else {
                    newLine = '    ' + line;
                    logger.info('line does not include anything')
                }
                return `${this.getPrefix(newLine) ? `${indentation}await drone.checkInterruption()\n`: ''}${newLine}`;
            }).join('\n');

            return `import asyncio\nfrom cde import drone\nimport Note\n\nasync def main():\n${source}\n    await drone.stop_execution()\n\nasyncio.ensure_future(main())`

            // return 'import asyncio\nfrom cde import drone\nimport Note\n\n' + source + '\nawait drone.stop_execution()';

        }

        getPySrc(): string {
            let source = this.editor.state.doc.toString();
            return this.formatPySrc(source);
        }

        getOutputElement(): HTMLElement {
            const outputID = getAttribute(this, 'output');
            if (outputID !== null) {
                const el = document.getElementById(outputID);
                if (el === null) {
                    const err = `py-repl ERROR: cannot find the output element #${outputID} in the DOM`;
                    this.outDiv.innerText = err;
                    return undefined;
                }
                return el;
            } else {
                return this.outDiv;
            }
        }

        // XXX the autogenerate logic is very messy. We should redo it, and it
        // should be the default.
        autogenerateMaybe(): void {
            if (this.hasAttribute('auto-generate')) {
                const allPyRepls = document.querySelectorAll(`py-repl[root='${this.getAttribute('root')}'][exec-id]`);
                const lastRepl = allPyRepls[allPyRepls.length - 1];
                const lastExecId = lastRepl.getAttribute('exec-id');
                const nextExecId = parseInt(lastExecId) + 1;

                const newPyRepl = document.createElement('py-repl');
                newPyRepl.setAttribute('root', this.getAttribute('root'));
                newPyRepl.id = this.getAttribute('root') + '-' + nextExecId.toString();

                if (this.hasAttribute('auto-generate')) {
                    newPyRepl.setAttribute('auto-generate', '');
                    this.removeAttribute('auto-generate');
                }

                const outputMode = getAttribute(this, 'output-mode');
                if (outputMode) {
                    newPyRepl.setAttribute('output-mode', outputMode);
                }

                const addReplAttribute = (attribute: string) => {
                    const attr = getAttribute(this, attribute);
                    if (attr) {
                        newPyRepl.setAttribute(attribute, attr);
                    }
                };

                addReplAttribute('output');

                newPyRepl.setAttribute('exec-id', nextExecId.toString());
                if (this.parentElement) {
                    this.parentElement.appendChild(newPyRepl);
                }
            }
        }
    }

    return PyRepl;
}
