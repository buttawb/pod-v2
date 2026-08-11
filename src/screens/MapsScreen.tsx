import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ListCard, PageHeader, Screen, SectionLabel, spacing } from '../ui/components';
import { RouteMapScreen } from '../maps/RouteMapScreen';
import { DepotMapScreen } from '../maps/DepotMapScreen';

type Surface = 'menu' | 'route' | 'depot';

export function MapsScreen({
  onOpenStop,
  onBack,
}: {
  onOpenStop: (stopId: string) => void;
  onBack: () => void;
}) {
  const [surface, setSurface] = useState<Surface>('menu');

  if (surface === 'route') {
    return <RouteMapScreen onOpenStop={onOpenStop} onBack={() => setSurface('menu')} />;
  }
  if (surface === 'depot') {
    return <DepotMapScreen onBack={() => setSurface('menu')} />;
  }

  return (
    <Screen>
      <PageHeader title="Maps" subtitle="Two views of the same day" onBack={onBack} />

      <View style={styles.content}>
        <SectionLabel>Choose a view</SectionLabel>

        <ListCard
          icon="navigation"
          title="My route"
          subtitle="Your stops and live position. Tap a pin to open the stop."
          onPress={() => setSurface('route')}
        />

        <ListCard
          icon="grid"
          title="Depot overview"
          subtitle="Every stop in the coverage area, filterable by status."
          onPress={() => setSurface('depot')}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm },
});
