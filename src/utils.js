/******************************************************************************

Flatmap viewer and annotation tool

Copyright (c) 2019  David Brooks

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

******************************************************************************/

'use strict';

//==============================================================================

export class List extends Array {
    constructor(iterable=null) {
        super();
        if (iterable !== null)
            this.extend(iterable);
    }

    append(element) {
        super.push(element);
        return this;
    }

    contains(element) {
        return (super.indexOf(element) >= 0);
    }

    extend(other) {
        if (this === other) {
            throw new Error('Cannot extend a list with itself...');
        } else if (other) {
            super.push(...other);
        }
        return this;
    }

    slice(start, end)
    //===============
    {
        return new List(Array(...this).slice(start, end));
    }
}

//==============================================================================

// From https://spin.atomicobject.com/2018/09/10/javascript-concurrency/

export class Mutex
{
    constructor()
    {
        this._mutex = Promise.resolve();
    }

    lock()
    //====
    {
        let begin = unlock => {};

        this._mutex = this._mutex.then(() => {
            return new Promise(begin);
        });

        return new Promise(res => {
            begin = res;
        });
    }

    async dispatch(fn)
    //================
    {
        const unlock = await this.lock();

        try {
            return await Promise.resolve(fn());
        } finally {
            unlock();
        }
    }
}

//==============================================================================

export function normaliseId(id)
{
    if (id.indexOf(':') < 0) {
        return id;
    }
    const parts = id.split(':')
    const lastPart = parts[parts.length - 1]
    if (['http', 'https', 'urn'].indexOf(parts[0]) >= 0 || '0123456789'.indexOf(lastPart[0]) < 0) {
        return id;
    }
    parts[parts.length - 1] = lastPart.padStart(8, '0');
    return parts.join(':');
}

//==============================================================================

export function setDefaults(options, defaultOptions)
{
    if (options === undefined || options === null) {
        return defaultOptions;
    }
    for (const [key, value] of Object.entries(defaultOptions)) {
        if (!(key in options)) {
            options[key] = value;
        }
    }
    return options;
}

//==============================================================================
