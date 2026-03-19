import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server/script/deps';
import { config } from '../config';

const rpName = config.webauthn.rpName;
const rpID = config.webauthn.rpId;
const origin = config.webauthn.origin;

export interface StoredPasskey {
  credentialId: Buffer;
  publicKey: Buffer;
  counter: number;
  transports?: string[];
}

export async function generateRegOptions(
  userId: string,
  userName: string,
  existingPasskeys: StoredPasskey[] = []
) {
  return generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(userId),
    userName,
    attestationType: 'none',
    excludeCredentials: existingPasskeys.map((pk) => ({
      id: pk.credentialId,
      type: 'public-key',
      transports: pk.transports as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
}

export async function verifyRegResponse(
  response: RegistrationResponseJSON,
  expectedChallenge: string
) {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
}

export async function generateAuthOptions(
  allowCredentials: { id: Buffer; transports?: string[] }[] = []
) {
  return generateAuthenticationOptions({
    rpID,
    allowCredentials: allowCredentials.map((c) => ({
      id: c.id,
      type: 'public-key',
      transports: c.transports as AuthenticatorTransportFuture[],
    })),
    userVerification: 'preferred',
  });
}

export async function verifyAuthResponse(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: StoredPasskey
) {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: credential.credentialId,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports as AuthenticatorTransportFuture[],
    },
  });
}
