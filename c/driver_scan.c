#define _POSIX_C_SOURCE 200809L

#include <dirent.h>
#include <errno.h>
#include <fnmatch.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/utsname.h>
#include <unistd.h>

typedef struct Alias {
    char *pattern;
    char *module;
    struct Alias *next;
} Alias;

static int join_path(char *result, size_t size, const char *base, const char *name) {
    int written = snprintf(result, size, "%s/%s", base, name);
    return written >= 0 && (size_t)written < size;
}

static int read_attribute(const char *device_path, const char *name, char *value, size_t size) {
    char path[PATH_MAX];
    if (!join_path(path, sizeof(path), device_path, name)) return 0;

    FILE *file = fopen(path, "r");
    if (!file) return 0;
    if (!fgets(value, (int)size, file)) {
        fclose(file);
        return 0;
    }
    fclose(file);

    value[strcspn(value, "\r\n")] = '\0';
    if (strncmp(value, "0x", 2) == 0 || strncmp(value, "0X", 2) == 0) {
        memmove(value, value + 2, strlen(value + 2) + 1);
    }
    return value[0] != '\0';
}

static int load_alias_file(const char *path, Alias **aliases) {
    FILE *file = fopen(path, "r");
    if (!file) return 0;

    char *line = NULL;
    size_t capacity = 0;
    while (getline(&line, &capacity, file) != -1) {
        char pattern[PATH_MAX];
        char module[PATH_MAX];
        if (sscanf(line, "alias %4095s %4095s", pattern, module) != 2) continue;

        Alias *alias = malloc(sizeof(*alias));
        if (!alias) {
            free(line);
            fclose(file);
            return 0;
        }
        alias->pattern = strdup(pattern);
        alias->module = strdup(module);
        if (!alias->pattern || !alias->module) {
            free(alias->pattern);
            free(alias->module);
            free(alias);
            free(line);
            fclose(file);
            return 0;
        }
        alias->next = *aliases;
        *aliases = alias;
    }

    int readable = !ferror(file);
    free(line);
    fclose(file);
    return readable;
}

static const char *find_module(const Alias *aliases, const char *modalias) {
    for (const Alias *alias = aliases; alias; alias = alias->next) {
        if (fnmatch(alias->pattern, modalias, 0) == 0) return alias->module;
    }
    return NULL;
}

static void print_device(const char *device_path, const char *address,
                         const Alias *aliases, int aliases_complete) {
    char vendor[128] = "-";
    char device[128] = "-";
    char link_path[PATH_MAX];
    char link_target[PATH_MAX];
    char modalias[PATH_MAX];
    const char *status = "unknown";
    const char *module = "-";
    const char *detail = "driver link unavailable";

    read_attribute(device_path, "vendor", vendor, sizeof(vendor));
    read_attribute(device_path, "device", device, sizeof(device));

    if (join_path(link_path, sizeof(link_path), device_path, "driver")) {
        ssize_t length = readlink(link_path, link_target, sizeof(link_target) - 1);
        if (length >= 0) {
            link_target[length] = '\0';
            char *name = strrchr(link_target, '/');
            name = name ? name + 1 : link_target;
            if (*name) {
                status = "bound";
                module = name;
                detail = "sysfs driver link";
            } else {
                detail = "driver link has no name";
            }
        } else if (errno == ENOENT) {
            if (!aliases_complete) {
                detail = "kernel module alias indexes unavailable";
            } else if (!read_attribute(device_path, "modalias", modalias, sizeof(modalias))) {
                detail = "device modalias unavailable";
            } else {
                const char *candidate = find_module(aliases, modalias);
                if (candidate) {
                    status = "available-unbound";
                    module = candidate;
                    detail = "matching module alias; not bound";
                } else {
                    status = "missing";
                    detail = "no matching installed module alias";
                }
            }
        } else {
            detail = "driver link unreadable";
        }
    } else {
        detail = "driver link path too long";
    }

    printf("%s\t%s\t%s\t%s\t%s\t%s\n",
           address, vendor, device, status, module, detail);
}

static void free_aliases(Alias *aliases) {
    while (aliases) {
        Alias *next = aliases->next;
        free(aliases->pattern);
        free(aliases->module);
        free(aliases);
        aliases = next;
    }
}

int main(int argc, char **argv) {
    if (argc > 3) {
        fprintf(stderr, "Usage: %s [sysfs-root] [kernel-modules-directory]\n", argv[0]);
        return 2;
    }

    const char *sysfs_root = argc >= 2 ? argv[1] : "/sys";
    char modules_dir[PATH_MAX];
    if (argc >= 3) {
        if (snprintf(modules_dir, sizeof(modules_dir), "%s", argv[2]) >= (int)sizeof(modules_dir)) {
            fprintf(stderr, "Kernel modules directory path is too long\n");
            return 2;
        }
    } else {
        struct utsname system;
        if (uname(&system) != 0 ||
            snprintf(modules_dir, sizeof(modules_dir), "/lib/modules/%s", system.release) >=
                (int)sizeof(modules_dir)) {
            fprintf(stderr, "Unable to determine the running kernel modules directory\n");
            return 1;
        }
    }

    Alias *aliases = NULL;
    char alias_path[PATH_MAX];
    int aliases_complete = join_path(alias_path, sizeof(alias_path), modules_dir, "modules.alias") &&
                           load_alias_file(alias_path, &aliases);
    aliases_complete = aliases_complete &&
        join_path(alias_path, sizeof(alias_path), modules_dir, "modules.builtin.alias") &&
        load_alias_file(alias_path, &aliases);

    char devices_path[PATH_MAX];
    if (!join_path(devices_path, sizeof(devices_path), sysfs_root, "bus/pci/devices")) {
        fprintf(stderr, "Sysfs device path is too long\n");
        free_aliases(aliases);
        return 1;
    }

    DIR *directory = opendir(devices_path);
    if (!directory) {
        fprintf(stderr, "Unable to read %s: %s\n", devices_path, strerror(errno));
        free_aliases(aliases);
        return 1;
    }

    puts("ADDRESS\tVENDOR\tDEVICE\tSTATUS\tMODULE\tDETAIL");
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (entry->d_name[0] == '.') continue;
        char device_path[PATH_MAX];
        if (join_path(device_path, sizeof(device_path), devices_path, entry->d_name)) {
            print_device(device_path, entry->d_name, aliases, aliases_complete);
        }
    }

    closedir(directory);
    free_aliases(aliases);
    return 0;
}