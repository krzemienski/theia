/********************************************************************************
 * Copyright (C) 2017 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable, inject, named } from 'inversify';
import { TextDocumentContentChangeEvent } from 'vscode-languageserver-protocol';
import URI from '../common/uri';
import { ContributionProvider } from './contribution-provider';
import { Event, Emitter } from './event';
import { Disposable } from './disposable';
import { MaybePromise } from './types';
import { CancellationToken } from './cancellation';
import { ApplicationError } from './application-error';

export interface ResourceVersion {
}

export interface ResourceReadOptions {
    encoding?: string
}

export interface ResourceSaveOptions {
    encoding?: string,
    overwriteEncoding?: string,
    version?: ResourceVersion
}

export interface Resource extends Disposable {
    readonly uri: URI;
    /**
     * Latest read version of this resource.
     *
     * Optional if a resource does not support versioning, check with `in` operator`.
     * Undefined if a resource did not read content yet.
     */
    readonly version?: ResourceVersion | undefined;
    /**
     * Reads latest content of this resource.
     *
     * If a resource supports versioning it updates version to latest.
     *
     * @throws `ResourceError.NotFound` if a resource not found
     */
    readContents(options?: ResourceReadOptions): Promise<string>;
    /**
     * Rewrites the complete content for this resource.
     * If a resource does not exist it will be created.
     *
     * If a resource supports versioning clients can pass some version
     * to check against it, if it is not provided latest version is used.
     * It updates version to latest.
     *
     * @throws `ResourceError.OutOfSync` if latest resource version is out of sync with the given
     */
    saveContents?(content: string, options?: ResourceSaveOptions): Promise<void>;
    /**
     * Applies incremental content changes to this resource.
     *
     * If a resource supports versioning clients can pass some version
     * to check against it, if it is not provided latest version is used.
     * It updates version to latest.
     *
     * @throws `ResourceError.NotFound` if a resource not found or was not read yet
     * @throws `ResourceError.OutOfSync` if latest resource version is out of sync with the given
     */
    saveContentChanges?(changes: TextDocumentContentChangeEvent[], options?: ResourceSaveOptions): Promise<void>;
    readonly onDidChangeContents?: Event<void>;
    guessEncoding?(): Promise<string | undefined>
}
export namespace Resource {
    export interface SaveContext {
        content: string
        changes?: TextDocumentContentChangeEvent[]
        options?: ResourceSaveOptions
    }
    export async function save(resource: Resource, context: SaveContext, token?: CancellationToken): Promise<void> {
        if (!resource.saveContents) {
            return;
        }
        if (await trySaveContentChanges(resource, context)) {
            return;
        }
        if (token && token.isCancellationRequested) {
            return;
        }
        await resource.saveContents(context.content, context.options);
    }
    export async function trySaveContentChanges(resource: Resource, context: SaveContext): Promise<boolean> {
        if (!context.changes || !resource.saveContentChanges || shouldSaveContent(context)) {
            return false;
        }
        try {
            await resource.saveContentChanges(context.changes, context.options);
            return true;
        } catch (e) {
            if (!ResourceError.NotFound.is(e) && !ResourceError.OutOfSync.is(e)) {
                console.error(`Failed to apply incremental changes to '${resource.uri.toString()}':`, e);
            }
            return false;
        }
    }
    export function shouldSaveContent({ content, changes }: SaveContext): boolean {
        if (!changes) {
            return true;
        }
        let contentChangesLength = 0;
        const contentLength = content.length;
        for (const change of changes) {
            contentChangesLength += JSON.stringify(change).length;
            if (contentChangesLength > contentLength) {
                return true;
            }
        }
        return contentChangesLength > contentLength;
    }
}

export namespace ResourceError {
    export const NotFound = ApplicationError.declare(-40000, (raw: ApplicationError.Literal<{ uri: URI }>) => raw);
    export const OutOfSync = ApplicationError.declare(-40001, (raw: ApplicationError.Literal<{ uri: URI }>) => raw);
}

export const ResourceResolver = Symbol('ResourceResolver');
export interface ResourceResolver {
    /**
     * Reject if a resource cannot be provided.
     */
    resolve(uri: URI): MaybePromise<Resource>;
}

export const ResourceProvider = Symbol('ResourceProvider');
export type ResourceProvider = (uri: URI) => Promise<Resource>;

@injectable()
export class DefaultResourceProvider {

    constructor(
        @inject(ContributionProvider) @named(ResourceResolver)
        protected readonly resolversProvider: ContributionProvider<ResourceResolver>
    ) { }

    /**
     * Reject if a resource cannot be provided.
     */
    async get(uri: URI): Promise<Resource> {
        const resolvers = this.resolversProvider.getContributions();
        for (const resolver of resolvers) {
            try {
                return await resolver.resolve(uri);
            } catch (err) {
                // no-op
            }
        }
        return Promise.reject(new Error(`A resource provider for '${uri.toString()}' is not registered.`));
    }

}

export class MutableResource implements Resource {
    private contents: string;

    constructor(readonly uri: URI, contents: string, readonly dispose: () => void) {
        this.contents = contents;
    }

    async readContents(): Promise<string> {
        return this.contents;
    }

    async saveContents(contents: string): Promise<void> {
        this.contents = contents;
        this.fireDidChangeContents();
    }

    protected readonly onDidChangeContentsEmitter = new Emitter<void>();
    onDidChangeContents = this.onDidChangeContentsEmitter.event;
    protected fireDidChangeContents(): void {
        this.onDidChangeContentsEmitter.fire(undefined);
    }
}

@injectable()
export class InMemoryResources implements ResourceResolver {

    private readonly resources = new Map<string, MutableResource>();

    add(uri: URI, contents: string): Resource {
        const resourceUri = uri.toString();
        if (this.resources.has(resourceUri)) {
            throw new Error(`Cannot add already existing in-memory resource '${resourceUri}'`);
        }

        const resource = new MutableResource(uri, contents, () => this.resources.delete(resourceUri));
        this.resources.set(resourceUri, resource);
        return resource;
    }

    update(uri: URI, contents: string): Resource {
        const resourceUri = uri.toString();
        const resource = this.resources.get(resourceUri);
        if (!resource) {
            throw new Error(`Cannot update non-existed in-memory resource '${resourceUri}'`);
        }
        resource.saveContents(contents);
        return resource;
    }

    resolve(uri: URI): Resource {
        const uriString = uri.toString();
        if (!this.resources.has(uriString)) {
            throw new Error(`In memory '${uriString}' resource does not exist.`);
        }
        return this.resources.get(uriString)!;
    }
}
