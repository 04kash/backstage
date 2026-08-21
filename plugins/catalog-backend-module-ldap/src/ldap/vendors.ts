/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Entry } from 'ldapts';

/**
 * An LDAP Vendor handles unique nuances between different vendors.
 *
 * @public
 */
export type LdapVendor = {
  /**
   * The attribute name that holds the distinguished name (DN) for an entry.
   */
  dnAttributeName: string;
  /**
   * The attribute name that holds a universal unique identifier for an entry.
   */
  uuidAttributeName: string;

  /**
   * Decode ldap entry values for a given attribute name to their string representation.
   *
   * @param entry - The ldap entry
   * @param name - The attribute to decode
   */
  decodeStringAttribute: (entry: Entry, name: string) => string[];
};

export const DefaultLdapVendor: LdapVendor = {
  dnAttributeName: 'entryDN',
  uuidAttributeName: 'entryUUID',
  decodeStringAttribute: (entry, name) => {
    return decode(entry, name, value => {
      return value.toString();
    });
  },
};

export const ActiveDirectoryVendor: LdapVendor = {
  dnAttributeName: 'distinguishedName',
  uuidAttributeName: 'objectGUID',
  decodeStringAttribute: (entry, name) => {
    const decoder = (value: string | Buffer) => {
      if (name === ActiveDirectoryVendor.uuidAttributeName) {
        return formatGUID(value);
      }
      return value.toString();
    };
    return decode(entry, name, decoder);
  },
};

export const FreeIpaVendor: LdapVendor = {
  dnAttributeName: 'dn',
  uuidAttributeName: 'ipaUniqueID',
  decodeStringAttribute: (entry, name) => {
    return decode(entry, name, value => {
      return value.toString();
    });
  },
};

export const AEDirVendor: LdapVendor = {
  dnAttributeName: 'dn',
  uuidAttributeName: 'entryUUID',
  decodeStringAttribute: (entry, name) => {
    return decode(entry, name, value => {
      return value.toString();
    });
  },
};

export const GoogleLdapVendor: LdapVendor = {
  dnAttributeName: 'dn',
  uuidAttributeName: 'uid',
  decodeStringAttribute: (entry, name) => {
    return decode(entry, name, value => {
      return value.toString();
    });
  },
};

export const LLDAPVendor: LdapVendor = {
  dnAttributeName: 'dn',
  uuidAttributeName: 'entryuuid',
  decodeStringAttribute: (entry, name) => {
    return decode(entry, name.toLocaleLowerCase('en-US'), value => {
      return value.toString();
    });
  },
};

// Decode an attribute to a consumer
function decode(
  entry: Entry,
  attributeName: string,
  decoder: (value: string | Buffer) => string,
): string[] {
  const values = entry[attributeName];
  if (Array.isArray(values)) {
    return values.map(v => {
      return decoder(v);
    });
  } else if (values) {
    return [decoder(values)];
  }
  return [];
}

// Formats a Microsoft Active Directory binary-encoded uuid to a readable string
// See https://github.com/ldapjs/node-ldapjs/issues/297#issuecomment-137765214
function formatGUID(objectGUID: string | Buffer): string {
  const data =
    typeof objectGUID === 'string'
      ? Buffer.from(objectGUID, 'binary')
      : objectGUID;

  // GUID_FORMAT_D — byte order per Active Directory objectGUID encoding
  const hex = [...data].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(6, 8)}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(
    0,
    2,
  )}-${hex.slice(10, 12)}${hex.slice(8, 10)}-${hex.slice(14, 16)}${hex.slice(
    12,
    14,
  )}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
