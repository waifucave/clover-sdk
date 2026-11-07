// process-holder: runs one command so that everything it starts can be found and stopped, even what it leaves behind
// (macOS). Built and signed by the host under its own identifier, never the host's.
//
//   process-holder <status-fd> <file> [args...]
//
// 1. It re-executes itself in place (POSIX_SPAWN_SETEXEC, same pid) with its responsibility disclaimed, so it is the
//    responsible process of every process the command starts: a background job, a nohup, a setsid or a double fork that
//    reparents to launchd, one that clears its environment. `responsibility_get_pid_responsible_for_pid` names it for
//    each of them for as long as it lives (it reverts once the responsible process is gone, so the holder stays).
// 2. It runs the command as its child and waits for it, then writes `exit <code> <left> <escaped>` (or
//    `signal <n> <left> <escaped>`) to the status fd: `<left>`, how many processes the command left behind;
//    `<escaped>`, how many other processes hold the command's output open (see "Not caught").
// 3. While any remain it stays, looking once a second, and exits when none do: the host adopts it as a background task.
//    Before it exits it writes `escaped <n>` if, by then, other processes hold the command's output open.
// 4. SIGTERM (or SIGINT, SIGHUP) stops everything: the command and every process responsible to the holder get SIGTERM;
//    two seconds later SIGKILL passes repeat until a scan finds none (at most 50), and the holder exits. The host waits
//    for that exit before its own SIGKILL to the group.
//
// Not caught:
//   * a process the command has launchd start (launchctl, open, an XPC service) is launchd's, not a descendant; the
//     host's `sandbox.denyLaunchServices` closes those paths;
//   * a process that disclaims its own responsibility (posix_spawn with `responsibility_spawnattrs_setdisclaim`, a few
//     lines of Python ctypes or bun:ffi) and starts a session of its own: it is its own responsible process. It stays
//     inside the command's Seatbelt sandbox (the sandbox is inherited through any spawn) and its fence. The holder
//     reports it as escaped when it holds the command's output open: the host's own pipe or socket to the command
//     (an inherited output is shared by design and not looked at), found in its file table, by a process responsible
//     neither to the holder nor to the host's responsible process. One that let go of the output as well is unseen.
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t pid);

static volatile sig_atomic_t stop_requested = 0;
static pid_t command_pid = -1;

static void on_stop(int sig) {
  (void)sig;
  stop_requested = 1;
}

/* Signals every process responsible to this holder, other than itself (signal 0: none, only counted); how many there
 * were. Any number of them: the system's whole list is read each time. */
static int signal_left(int sig) {
  pid_t self = getpid();
  int n = proc_listallpids(NULL, 0);
  if (n <= 0) return 0;
  size_t cap = (size_t)n + 1024;
  pid_t *all = calloc(cap, sizeof(pid_t));
  if (all == NULL) return 0;
  n = proc_listallpids(all, (int)(cap * sizeof(pid_t)));
  int found = 0;
  for (int i = 0; i < n; i++) {
    pid_t p = all[i];
    if (p <= 1 || p == self) continue;
    if (responsibility_get_pid_responsible_for_pid(p) != self) continue;
    if (sig != 0) kill(p, sig);
    found++;
  }
  free(all);
  return found;
}

/* The command's output (fds 1 and 2): the kernel handle of each, a pipe's or a Unix socket's, so another process
 * holding it can be found. */
static pid_t host_pid = -1;
static int out_kind[2];
static uint64_t out_handle[2];
static int out_count = 0;

static int handle_of(pid_t pid, int fd, int kind, uint64_t *handle, uint64_t *peer) {
  if (kind == PROX_FDTYPE_PIPE) {
    struct pipe_fdinfo pi;
    if (proc_pidfdinfo(pid, fd, PROC_PIDFDPIPEINFO, &pi, sizeof pi) != (int)sizeof pi) return 0;
    *handle = pi.pipeinfo.pipe_handle;
    if (peer != NULL) *peer = pi.pipeinfo.pipe_peerhandle;
    return 1;
  }
  if (kind == PROX_FDTYPE_SOCKET) {
    struct socket_fdinfo si;
    if (proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, &si, sizeof si) != (int)sizeof si) return 0;
    if (si.psi.soi_kind != SOCKINFO_UN) return 0;
    *handle = si.psi.soi_so;
    if (peer != NULL) *peer = si.psi.soi_proto.pri_un.unsi_conn_so;
    return 1;
  }
  return 0;
}

/* Whether `pid` has an open descriptor of `kind` whose handle is `handle`. */
static int holds_handle(pid_t pid, int kind, uint64_t handle) {
  int size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (size <= 0) return 0;
  size_t cap = (size_t)size + 64 * sizeof(struct proc_fdinfo);
  struct proc_fdinfo *fds = malloc(cap);
  if (fds == NULL) return 0;
  size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, (int)cap);
  int holds = 0;
  for (int f = 0; f < size / (int)sizeof(struct proc_fdinfo) && !holds; f++) {
    uint64_t h;
    if ((int)fds[f].proc_fdtype == kind && handle_of(pid, fds[f].proc_fd, kind, &h, NULL) && h == handle) holds = 1;
  }
  free(fds);
  return holds;
}

/* Notes the command's output: only a channel whose other end the host holds (its own pipe or socket to the command),
 * so a copy anywhere else came from the command. An inherited descriptor (a terminal, a file, the host's own output)
 * is shared with others by design and is not looked at. */
static void note_output(void) {
  if (host_pid <= 1) return;
  for (int fd = STDOUT_FILENO; fd <= STDERR_FILENO; fd++) {
    int kinds[2] = { PROX_FDTYPE_PIPE, PROX_FDTYPE_SOCKET };
    for (int k = 0; k < 2; k++) {
      uint64_t h, peer;
      if (out_count < 2 && handle_of(getpid(), fd, kinds[k], &h, &peer) && holds_handle(host_pid, kinds[k], peer)) {
        out_kind[out_count] = kinds[k];
        out_handle[out_count++] = h;
        break;
      }
    }
  }
}

/* How many processes hold the command's output open that got out from under the holder: a process that disclaimed
 * itself is its own responsible process (and its children are its). Never one responsible to the holder, nor to the
 * host's own responsible process (the host's other processes, which may have caught a copy of the output while it was
 * being set up). */
static int escaped(void) {
  if (out_count == 0) return 0;
  pid_t self = getpid();
  pid_t host_responsible = responsibility_get_pid_responsible_for_pid(host_pid);
  int n = proc_listallpids(NULL, 0);
  if (n <= 0) return 0;
  size_t cap = (size_t)n + 1024;
  pid_t *all = calloc(cap, sizeof(pid_t));
  if (all == NULL) return 0;
  n = proc_listallpids(all, (int)(cap * sizeof(pid_t)));
  int found = 0;
  for (int i = 0; i < n; i++) {
    pid_t p = all[i];
    if (p <= 1 || p == self || p == host_pid) continue;
    pid_t responsible = responsibility_get_pid_responsible_for_pid(p);
    if (responsible == self || responsible == host_responsible) continue;
    int holds = 0;
    for (int o = 0; o < out_count && !holds; o++) holds = holds_handle(p, out_kind[o], out_handle[o]);
    found += holds;
  }
  free(all);
  return found;
}

static void reap(void) {
  while (waitpid(-1, NULL, WNOHANG) > 0) {}
}

static void sleep_ms(long ms) {
  struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
  nanosleep(&ts, NULL);
}

/* Stops the command and everything responsible to the holder: SIGTERM; two seconds later, SIGKILL passes until a scan
 * finds none (at most 50, 100 ms apart), since a process can start another between a scan and its kill. */
static void stop_all(void) {
  if (command_pid > 0) kill(command_pid, SIGTERM);
  signal_left(SIGTERM);
  for (int t = 0; t < 20; t++) {
    reap();
    if (signal_left(0) == 0 && (command_pid <= 0 || kill(command_pid, 0) != 0)) return;
    sleep_ms(100);
  }
  if (command_pid > 0) kill(command_pid, SIGKILL);
  for (int pass = 0; pass < 50; pass++) {
    reap();
    if (signal_left(SIGKILL) == 0) break;
    sleep_ms(100);
  }
  reap();
}

static void write_line(int fd, const char *line) {
  if (fd >= 0) (void)!write(fd, line, strlen(line));
}

static void write_status(int fd, const char *what, int value, int left, int escapes) {
  char line[96];
  snprintf(line, sizeof line, "%s %d %d %d\n", what, value, left, escapes);
  write_line(fd, line);
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: process-holder <status-fd> <file> [args...]\n");
    return 64;
  }
  // Step 1: become the responsible process of everything below, in place (same pid, same descriptors). A process is
  // its own responsible process only once disclaimed (or when launchd started it, which a host never does), so that is
  // the second pass's mark: nothing in the environment or the arguments can fake it.
  if (responsibility_get_pid_responsible_for_pid(getpid()) != getpid()) {
    char self[PROC_PIDPATHINFO_MAXSIZE];
    posix_spawnattr_t attr;
    if (proc_pidpath(getpid(), self, sizeof self) > 0 && posix_spawnattr_init(&attr) == 0) {
      short flags = 0;
      posix_spawnattr_getflags(&attr, &flags);
      posix_spawnattr_setflags(&attr, flags | POSIX_SPAWN_SETEXEC);
      if (responsibility_spawnattrs_setdisclaim(&attr, 1) == 0) {
        pid_t ignored;
        posix_spawn(&ignored, self, NULL, &attr, argv, environ);
        // Only reached when the re-exec failed: go on undisclaimed (the host still has the process group).
      }
      posix_spawnattr_destroy(&attr);
    }
  }
  // A closed pipe never kills the holder (the command's own SIGPIPE is reset to the default below).
  signal(SIGPIPE, SIG_IGN);

  int status_fd = atoi(argv[1]);
  if (status_fd > 2) fcntl(status_fd, F_SETFD, FD_CLOEXEC);
  else status_fd = -1;

  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_stop;
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);

  host_pid = getppid();
  note_output();

  // Step 2: the command, as this holder's child, in its process group.
  posix_spawnattr_t cattr;
  posix_spawnattr_init(&cattr);
  sigset_t none;
  sigemptyset(&none);
  posix_spawnattr_setsigmask(&cattr, &none);
  sigset_t defaults;
  sigemptyset(&defaults);
  sigaddset(&defaults, SIGTERM);
  sigaddset(&defaults, SIGINT);
  sigaddset(&defaults, SIGHUP);
  sigaddset(&defaults, SIGPIPE);
  posix_spawnattr_setsigdefault(&cattr, &defaults);
  posix_spawnattr_setflags(&cattr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  int rc = posix_spawn(&command_pid, argv[2], NULL, &cattr, &argv[2], environ);
  posix_spawnattr_destroy(&cattr);
  if (rc != 0) {
    fprintf(stderr, "process-holder: could not start %s: %s\n", argv[2], strerror(rc));
    write_status(status_fd, "exit", 127, 0, 0);
    return 127;
  }
  int wstatus = 0;
  for (;;) {
    pid_t r = waitpid(command_pid, &wstatus, 0);
    if (r == command_pid) break;
    if (r < 0 && errno != EINTR) break;
    if (stop_requested) {
      stop_all();
      write_status(status_fd, "signal", SIGTERM, 0, 0);
      return 143;
    }
  }
  command_pid = -1;
  int left = signal_left(0);
  // The command's output pipes are the host's: the holder lets go of its own copies, so they close once nothing the
  // command left is writing to them.
  int devnull = open("/dev/null", O_RDWR);
  if (devnull >= 0) {
    dup2(devnull, STDIN_FILENO);
    dup2(devnull, STDOUT_FILENO);
    dup2(devnull, STDERR_FILENO);
    if (devnull > 2) close(devnull);
  }
  int escapes = escaped();
  if (WIFSIGNALED(wstatus)) write_status(status_fd, "signal", WTERMSIG(wstatus), left, escapes);
  else write_status(status_fd, "exit", WEXITSTATUS(wstatus), left, escapes);

  // Step 3: stay while anything the command left runs; step 4 on a stop.
  while (left > 0) {
    if (stop_requested) {
      stop_all();
      return 143;
    }
    sleep_ms(1000);
    reap();
    left = signal_left(0);
  }
  if (escapes == 0) {
    escapes = escaped();
    if (escapes > 0) {
      char line[32];
      snprintf(line, sizeof line, "escaped %d\n", escapes);
      write_line(status_fd, line);
    }
  }
  return 0;
}
