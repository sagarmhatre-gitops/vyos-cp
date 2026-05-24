// Package crypto provides at-rest encryption for device API keys.
// Uses NaCl secretbox (XSalsa20+Poly1305). Master key comes from
// VYOS_CP_SEAL_KEY env var — 32 bytes, hex-encoded.
package crypto

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"golang.org/x/crypto/nacl/secretbox"
)

type Sealer struct{ key [32]byte }

func NewSealer(hexKey string) (*Sealer, error) {
	raw, err := hex.DecodeString(hexKey)
	if err != nil {
		return nil, fmt.Errorf("decode seal key: %w", err)
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("seal key must be 32 bytes, got %d", len(raw))
	}
	var s Sealer
	copy(s.key[:], raw)
	return &s, nil
}

func (s *Sealer) Seal(plaintext string) ([]byte, error) {
	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	return secretbox.Seal(nonce[:], []byte(plaintext), &nonce, &s.key), nil
}

func (s *Sealer) Open(ct []byte) (string, error) {
	if len(ct) < 24 {
		return "", errors.New("ciphertext too short")
	}
	var nonce [24]byte
	copy(nonce[:], ct[:24])
	pt, ok := secretbox.Open(nil, ct[24:], &nonce, &s.key)
	if !ok {
		return "", errors.New("decrypt: authentication failed")
	}
	return string(pt), nil
}
