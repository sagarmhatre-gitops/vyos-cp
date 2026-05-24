package crypto

import (
	"crypto/rand"
	"encoding/hex"
	"testing"
)

func TestSealer_RoundTrip(t *testing.T) {
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	s, err := NewSealer(hex.EncodeToString(key))
	if err != nil {
		t.Fatal(err)
	}
	plaintext := "MY-VYOS-API-KEY-12345"
	ct, err := s.Seal(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	// Nonce is prefixed so ciphertext must be at least 24 + 16 (poly1305 tag) bytes
	// longer than plaintext.
	if len(ct) < 24+16+len(plaintext) {
		t.Errorf("ciphertext too short: %d", len(ct))
	}
	pt, err := s.Open(ct)
	if err != nil {
		t.Fatal(err)
	}
	if pt != plaintext {
		t.Errorf("round-trip failed: got %q", pt)
	}
}

func TestSealer_TamperDetection(t *testing.T) {
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	s, _ := NewSealer(hex.EncodeToString(key))
	ct, _ := s.Seal("secret")
	// Flip a bit past the nonce.
	ct[30] ^= 0x01
	if _, err := s.Open(ct); err == nil {
		t.Error("expected Open to fail on tampered ciphertext")
	}
}

func TestSealer_WrongKeyLength(t *testing.T) {
	if _, err := NewSealer("deadbeef"); err == nil {
		t.Error("expected error for short key")
	}
}
