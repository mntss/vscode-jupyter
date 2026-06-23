// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as fs from 'fs';
import { inject, injectable } from 'inversify';
import { extensions, type Extension } from 'vscode';
import { IDisposableRegistry, IExtensions } from '../types';
import { DataScience } from '../utils/localize';
import { parseStack } from '../../errors';
import { JVSC_EXTENSION_ID, unknownExtensionId } from '../constants';
import { logger } from '../../logging';

/**
 * Provides functions for tracking the list of extensions that VS code has installed (besides our own)
 */
@injectable()
export class Extensions implements IExtensions {
    private _extensions: readonly Extension<unknown>[] = [];
    private get extensions() {
        return this._extensions;
    }
    constructor(@inject(IDisposableRegistry) disposables: IDisposableRegistry) {
        disposables.push(extensions.onDidChange(() => (this._extensions = extensions.all)));
        this._extensions = extensions.all;
    }
    public determineExtensionFromCallStack(stack?: string): { extensionId: string; displayName: string } {
        stack = stack || new Error().stack;
        try {
            const jupyterExtRoot = extensions.getExtension(JVSC_EXTENSION_ID)!.extensionUri.toString().toLowerCase();
            let frames: string[] = [];
            if (stack) {
                frames = stack
                    .split('\n')
                    .map((f) => {
                        const result = /\((.*)\)/.exec(f);
                        const filenameWithPositions = result ? result[1] : undefined;
                        try {
                            const filename = /\((.*)\:\d*\:\d*\)/.exec(f);
                            if (!filename) {
                                return filenameWithPositions;
                            }
                            if (!filenameWithPositions) {
                                return filename[1];
                            }
                            if (filenameWithPositions.startsWith(filename[1])) {
                                return filename[1];
                            }
                        } catch {
                            //
                        }
                        return filenameWithPositions;
                    })
                    .filter((item) => item && !item.toLowerCase().startsWith(jupyterExtRoot)) as string[];
                const folderParts = jupyterExtRoot.split(/[\\/]/);
                const indexOfJupyterExtFolder = folderParts.findIndex((item) => item.startsWith(JVSC_EXTENSION_ID));
                const extensionFolderName =
                    indexOfJupyterExtFolder === -1 ? undefined : folderParts[indexOfJupyterExtFolder - 1];

                parseStack(new Error('Ex')).forEach((item) => {
                    const fileName = item.getFileName();
                    if (fileName && !fileName.toLowerCase().startsWith(jupyterExtRoot)) {
                        frames.push(fileName);
                    }
                });
                // The stack-frame path and `extensionUri.fsPath` can differ only by symlink resolution
                // (e.g. when `~/.vscode-server` is a symlink, common on remote/coder/devcontainer setups).
                // A plain `startsWith()` then fails and the caller resolves to "unknown", which auto-denies
                // kernel API access without ever showing the consent prompt. Compare canonical (realpath)
                // forms in addition to the literal paths.
                const realpathCache = new Map<string, string>();
                const realLower = (p: string): string => {
                    const cached = realpathCache.get(p);
                    if (cached !== undefined) {
                        return cached;
                    }
                    let resolved: string;
                    try {
                        resolved = fs.realpathSync(p).toLowerCase();
                    } catch {
                        resolved = p.toLowerCase();
                    }
                    realpathCache.set(p, resolved);
                    return resolved;
                };
                for (const frame of frames) {
                    const frameLower = frame.toLowerCase();
                    const frameReal = realLower(frame);
                    const matchingExt = this.extensions.find((ext) => {
                        if (ext.id === JVSC_EXTENSION_ID) {
                            return false;
                        }
                        const fsPathLower = ext.extensionUri.fsPath.toLowerCase();
                        if (
                            frameLower.startsWith(fsPathLower) ||
                            frameLower.startsWith(ext.extensionUri.path.toLowerCase())
                        ) {
                            return true;
                        }
                        const fsPathReal = realLower(ext.extensionUri.fsPath);
                        return frameReal.startsWith(fsPathReal) || frameReal.startsWith(fsPathLower);
                    });
                    if (matchingExt) {
                        return { extensionId: matchingExt.id, displayName: matchingExt.packageJSON.displayName };
                    }
                }
                // We're just after the extensions folder.
                let extensionPathFromFrames = frames.find((frame) => frame.includes(JVSC_EXTENSION_ID));
                if (extensionPathFromFrames) {
                    extensionPathFromFrames = extensionPathFromFrames.substring(
                        0,
                        extensionPathFromFrames.indexOf(JVSC_EXTENSION_ID) - 1
                    );
                }

                if (!extensionFolderName || !extensionPathFromFrames) {
                    return { extensionId: unknownExtensionId, displayName: DataScience.unknownPackage };
                }
                // Possible Jupyter extension root is ~/.vscode-server-insiders/extensions/ms-toolsai.jupyter-2024.3.0
                // But call stack has paths such as ~/.vscode-insiders/extensions/ms-toolsai.vscode-jupyter-powertoys-0.1.0/out/main.js
                for (const frame of frames.filter((f) => {
                    return f.startsWith(extensionPathFromFrames!) && !f.includes(JVSC_EXTENSION_ID);
                })) {
                    let extensionIdInFrame = frame
                        .substring(extensionPathFromFrames.length)
                        .substring(1)
                        .split(/[\\/]/)[0];
                    if (extensionIdInFrame.includes('-')) {
                        extensionIdInFrame = extensionIdInFrame.substring(0, extensionIdInFrame.lastIndexOf('-'));
                    }
                    const matchingExt = this.extensions.find((ext) => ext.id === extensionIdInFrame);
                    if (matchingExt) {
                        return { extensionId: matchingExt.id, displayName: matchingExt.packageJSON.displayName };
                    }
                }
            }
            logger.error(`Unable to determine the caller of the extension API for trace stack`, stack);
            logger.error(`Jupyter Root`, jupyterExtRoot);
            logger.error(`Frames`, frames);
            return { extensionId: unknownExtensionId, displayName: DataScience.unknownPackage };
        } catch (ex) {
            logger.error(`Unable to determine the caller of the extension API for trace stack.`, stack);
            logger.error(`Failure error`, ex);
            return { extensionId: unknownExtensionId, displayName: DataScience.unknownPackage };
        }
    }
}
