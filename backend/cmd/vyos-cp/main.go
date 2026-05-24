// Command vyos-cp is the control plane HTTP server.
package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/vyos-cp/vyos-cp/internal/api"
	"github.com/vyos-cp/vyos-cp/internal/crypto"
	"github.com/vyos-cp/vyos-cp/internal/poller"
	"github.com/vyos-cp/vyos-cp/internal/service"
	"github.com/vyos-cp/vyos-cp/internal/store"
)

// version is set at build time via -ldflags.
var version = "dev"

//go:embed all:static
var staticFS embed.FS

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	dsn := envOr("VYOS_CP_DSN", "postgres://vyoscp:vyoscp@localhost:5432/vyoscp?sslmode=disable")

	sealKey := os.Getenv("VYOS_CP_SEAL_KEY")
	if sealKey == "" {
		log.Fatal("VYOS_CP_SEAL_KEY is required (32 bytes hex). Generate with: openssl rand -hex 32")
	}
	sealer, err := crypto.NewSealer(sealKey)
	if err != nil {
		log.Fatalf("seal key: %v", err)
	}

	jwtKey := []byte(os.Getenv("VYOS_CP_JWT_KEY"))
	if len(jwtKey) < 32 {
		// Generate a runtime key if none given. Tokens won't survive a restart
		// but for a dev run this is fine. Production should set this.
		jwtKey = make([]byte, 32)
		_, _ = rand.Read(jwtKey)
		log.Printf("VYOS_CP_JWT_KEY not set, using ephemeral key (%s prefix)", hex.EncodeToString(jwtKey[:4]))
	}

	s, err := store.Open(ctx, dsn, sealer)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer s.Close()

	if v := os.Getenv("VYOS_CP_COMMIT_CONFIRM_MINUTES"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			log.Fatalf("VYOS_CP_COMMIT_CONFIRM_MINUTES must be integer: %v", err)
		}
		service.CommitConfirmMinutes = n
	}

	svc := service.New(s)

	pollInterval := 10 * time.Second
	if v := os.Getenv("VYOS_CP_POLL_INTERVAL_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			pollInterval = time.Duration(n) * time.Second
		}
	}
	p := poller.New(s, svc.GetClient, pollInterval)
	p.SetMetricsCollector(svc) // device-metrics history sampling
	go p.Run(ctx)

	// Extract the embedded static FS (from static/ subdir).
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("static: %v", err)
	}
	server := api.NewServer(svc, p, jwtKey, sub)

	addr := envOr("VYOS_CP_LISTEN", ":8080")
	srv := &http.Server{
		Addr:              addr,
		Handler:           server.Router(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
	        log.Printf("vyos-cp %s listening on %s", version, addr)	
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down...")
	shutCtx, cancel2 := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel2()
	_ = srv.Shutdown(shutCtx)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
